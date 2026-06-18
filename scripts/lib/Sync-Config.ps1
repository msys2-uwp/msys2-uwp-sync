#requires -Version 7.0

. "$PSScriptRoot/Sync-Common.ps1"

function Get-SyncConfig {
    param(
        [string] $RepoRoot = (Get-SyncRepoRoot),
        [string] $ConfigPath
    )

    if (-not $ConfigPath) {
        $ConfigPath = Join-Path $RepoRoot 'config/sync.json'
    }

    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        throw "Config file not found: $ConfigPath"
    }

    $json = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8
    return ($json | ConvertFrom-Json -Depth 20)
}

function Get-SourceRepoSlug {
    param(
        [Parameter(Mandatory)] $SourceEntry
    )
    return "$($SourceEntry.owner)/$($SourceEntry.repo)"
}

function Get-SourceCloneUrl {
    param(
        [Parameter(Mandatory)] $SourceEntry
    )
    return "https://github.com/$(Get-SourceRepoSlug -SourceEntry $SourceEntry).git"
}

function Get-DestinationCloneUrl {
    param(
        [Parameter(Mandatory)] $Config
    )
    if ($Config.destination.url) {
        return $Config.destination.url
    }
    return "https://github.com/$($Config.destination.owner)/$($Config.destination.repo).git"
}
