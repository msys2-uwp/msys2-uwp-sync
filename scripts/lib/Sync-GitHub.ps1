#requires -Version 7.0

. "$PSScriptRoot/Sync-Common.ps1"
. "$PSScriptRoot/Sync-Config.ps1"

function Get-RemoteBranchTip {
    param(
        [Parameter(Mandatory)] $SourceEntry
    )

    $url = Get-SourceCloneUrl -SourceEntry $SourceEntry
    $ref = "refs/heads/$($SourceEntry.branch)"
    $output = Invoke-Git -GitArgs @('ls-remote', $url, $ref)
    $line = ($output | Select-Object -First 1).ToString().Trim()
    if (-not $line) {
        throw "Could not resolve tip for $url $ref"
    }
    return ($line -split "\s+")[0]
}

function Get-AllUpstreamTips {
    param(
        [Parameter(Mandatory)] $Config
    )

    $tips = @{}
    foreach ($prop in $Config.sources.PSObject.Properties) {
        $tips[$prop.Name] = Get-RemoteBranchTip -SourceEntry $prop.Value
    }
    return $tips
}

function Test-UpstreamChanged {
    param(
        [Parameter(Mandatory)] $State,
        [Parameter(Mandatory)][hashtable] $CurrentTips,
        [switch] $Force
    )

    if ($Force) { return $true }

    foreach ($key in $CurrentTips.Keys) {
        $previous = $State.lastUpstreamCheck.$key
        if ($previous -ne $CurrentTips[$key]) {
            return $true
        }
    }
    return $false
}
