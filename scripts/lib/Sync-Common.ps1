#requires -Version 7.0

function Write-SyncLog {
    param(
        [Parameter(Mandatory)]
        [string] $Message,
        [ValidateSet('Info', 'Warn', 'Error')]
        [string] $Level = 'Info'
    )
    $prefix = switch ($Level) {
        'Warn' { '[sync][warn]' }
        'Error' { '[sync][error]' }
        default { '[sync]' }
    }
    Write-Host "$prefix $Message"
}

function Invoke-Git {
    param(
        [string] $RepoPath,
        [Parameter(Mandatory)]
        [string[]] $GitArgs
    )

    $allArgs = if ($RepoPath) { @('-C', $RepoPath) + $GitArgs } else { $GitArgs }
    $output = & git @allArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        $cmd = "git $($allArgs -join ' ')"
        throw "git command failed ($cmd): $output"
    }
    return $output
}

function Get-SyncRepoRoot {
    param([string] $StartPath = $PSScriptRoot)

    $current = Resolve-Path -LiteralPath $StartPath
    while ($true) {
        $configPath = Join-Path $current.Path 'config/sync.json'
        if (Test-Path -LiteralPath $configPath) {
            return $current.Path
        }
        $parent = Split-Path -Parent $current.Path
        if (-not $parent -or $parent -eq $current.Path) {
            throw 'Could not locate sync repo root (config/sync.json not found).'
        }
        $current = Resolve-Path -LiteralPath $parent
    }
}

function Get-WorkDirectory {
    param([Parameter(Mandatory)][string] $RepoRoot)
    $work = Join-Path $RepoRoot '.work'
    if (-not (Test-Path -LiteralPath $work)) {
        New-Item -ItemType Directory -Path $work | Out-Null
    }
    return $work
}

function ConvertTo-UnixLineEndings {
    param([string] $Text)
    if ($null -eq $Text) { return '' }
    return ($Text -replace "`r`n", "`n" -replace "`r", "`n")
}
