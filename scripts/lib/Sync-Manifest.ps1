#requires -Version 7.0

. "$PSScriptRoot/Sync-Common.ps1"

function Get-ManifestPath {
    param([Parameter(Mandatory)][string] $RepoRoot)
    return Join-Path $RepoRoot '.sync/replay-manifest.json'
}

function Get-ReplayManifest {
    param(
        [Parameter(Mandatory)][string] $RepoRoot
    )

    $path = Get-ManifestPath -RepoRoot $RepoRoot
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Manifest file not found: $path"
    }

    $json = Get-Content -LiteralPath $path -Raw -Encoding UTF8
    return ($json | ConvertFrom-Json -Depth 20)
}

function Save-ReplayManifest {
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [Parameter(Mandatory)] $Manifest
    )

    $path = Get-ManifestPath -RepoRoot $RepoRoot
    $json = $Manifest | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($path, "$json`n", [System.Text.UTF8Encoding]::new($false))
}

function Get-ManifestContentHash {
    param(
        [Parameter(Mandatory)][string] $RepoRoot
    )

    $path = Get-ManifestPath -RepoRoot $RepoRoot
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    return ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
}

function Compare-ReplayManifest {
    param(
        [Parameter(Mandatory)] $Expected,
        [Parameter(Mandatory)] $Actual
    )

    $fields = @(
        'replaySpecVersion',
        'baseCommit',
        'commitCount',
        'destinationTipSha',
        'treeRootSha'
    )

    foreach ($field in $fields) {
        if ("$($Expected.$field)" -ne "$($Actual.$field)") {
            return [pscustomobject]@{
                Match = $false
                Field = $field
                Expected = $Expected.$field
                Actual = $Actual.$field
            }
        }
    }

    foreach ($sourceId in @('ports', 'ports-mingw')) {
        $e = $Expected.upstreamPins.$sourceId
        $a = $Actual.upstreamPins.$sourceId
        if ("$e" -ne "$a") {
            return [pscustomobject]@{
                Match = $false
                Field = "upstreamPins.$sourceId"
                Expected = $e
                Actual = $a
            }
        }
    }

    return [pscustomobject]@{ Match = $true }
}

function New-ReplayManifest {
    param(
        [Parameter(Mandatory)] $Config,
        [Parameter(Mandatory)][hashtable] $UpstreamPins,
        [Parameter(Mandatory)][int] $CommitCount,
        [Parameter(Mandatory)][string] $DestinationTipSha,
        [Parameter(Mandatory)][string] $TreeRootSha
    )

    return [pscustomobject]@{
        replaySpecVersion = $Config.replaySpecVersion
        baseCommit = $Config.destination.baseCommit
        upstreamPins = [ordered]@{
            ports = $UpstreamPins.ports
            'ports-mingw' = $UpstreamPins['ports-mingw']
        }
        commitCount = $CommitCount
        destinationTipSha = $DestinationTipSha
        treeRootSha = $TreeRootSha
    }
}
