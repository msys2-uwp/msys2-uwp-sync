#requires -Version 7.0
<#
.SYNOPSIS
    Replay upstream MSYS2 package history into msys2-uwp/msys2-uwp.
#>
[CmdletBinding()]
param(
    [ValidateSet('Bootstrap', 'Incremental', 'Rebuild', 'Verify')]
    [string] $Mode = 'Incremental',
    [string] $DestinationPath,
    [string] $BranchName,
    [int] $MaxCommits = 0,
    [switch] $DryRun,
    [switch] $SkipFetch,
    [switch] $Force,
    [switch] $PushDestination,
    [switch] $PushState
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. "$PSScriptRoot/lib/Sync-Replay.ps1"

try {
    if ($Mode -eq 'Verify') {
        $null = Invoke-RebuildVerify -RepoRoot $repoRoot -DestinationPath $DestinationPath -DryRun:$DryRun
        exit 0
    }

    $result = Start-ReplaySync `
        -RepoRoot $repoRoot `
        -Mode $Mode `
        -DestinationPath $DestinationPath `
        -BranchName $BranchName `
        -MaxCommits $MaxCommits `
        -DryRun:$DryRun `
        -SkipFetch:$SkipFetch `
        -Force:$Force

    if ($result.Skipped) {
        exit 0
    }

    Complete-ReplaySync `
        -RepoRoot $repoRoot `
        -Result $result `
        -Mode $Mode `
        -DryRun:$DryRun `
        -PushDestination:$PushDestination `
        -PushState:$PushState

    exit 0
}
catch {
    Write-SyncLog $_.Exception.Message -Level Error
    if ($_.ScriptStackTrace) {
        Write-SyncLog $_.ScriptStackTrace -Level Error
    }
    exit 1
}
