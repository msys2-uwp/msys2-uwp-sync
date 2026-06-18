#requires -Version 7.0

. "$PSScriptRoot/Sync-Common.ps1"

function Get-SyncStatePath {
    param([Parameter(Mandatory)][string] $RepoRoot)
    return Join-Path $RepoRoot '.sync/state.json'
}

function Get-SyncState {
    param(
        [Parameter(Mandatory)][string] $RepoRoot
    )

    $path = Get-SyncStatePath -RepoRoot $RepoRoot
    if (-not (Test-Path -LiteralPath $path)) {
        throw "State file not found: $path"
    }

    $json = Get-Content -LiteralPath $path -Raw -Encoding UTF8
    return ($json | ConvertFrom-Json -Depth 20)
}

function Save-SyncState {
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [Parameter(Mandatory)] $State
    )

    $path = Get-SyncStatePath -RepoRoot $RepoRoot
    $json = $State | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($path, "$json`n", [System.Text.UTF8Encoding]::new($false))
}

function Initialize-SyncStateFromConfig {
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [Parameter(Mandatory)] $Config
    )

    $sources = @{}
    foreach ($prop in $Config.sources.PSObject.Properties) {
        $id = $prop.Name
        $entry = $prop.Value
        $sources[$id] = [ordered]@{
            repo = Get-SourceRepoSlug -SourceEntry $entry
            branch = $entry.branch
            lastReplayedSha = $null
        }
    }

    return [pscustomobject]@{
        version = 1
        destination = [ordered]@{
            branch = $Config.destination.branch
            baseCommit = $Config.destination.baseCommit
        }
        sources = $sources
        destinationBranchTip = $null
        replayManifestSha = $null
        lastSyncAt = $null
        lastUpstreamCheck = [ordered]@{
            ports = $null
            'ports-mingw' = $null
        }
    }
}

function Update-LastUpstreamCheck {
    param(
        [Parameter(Mandatory)] $State,
        [Parameter(Mandatory)][hashtable] $Tips
    )

    foreach ($key in $Tips.Keys) {
        $State.lastUpstreamCheck.$key = $Tips[$key]
    }
}

function Set-SourceCursor {
    param(
        [Parameter(Mandatory)] $State,
        [Parameter(Mandatory)][string] $SourceId,
        [Parameter(Mandatory)][string] $Sha
    )
    $State.sources.$SourceId.lastReplayedSha = $Sha
}

function Get-SourceCursor {
    param(
        [Parameter(Mandatory)] $State,
        [Parameter(Mandatory)][string] $SourceId
    )
    return $State.sources.$SourceId.lastReplayedSha
}
