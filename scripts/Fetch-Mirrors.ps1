#requires -Version 7.0
<#
.SYNOPSIS
    Clone or fetch upstream mirror repos into .work/mirrors/.
#>
[CmdletBinding()]
param(
    [switch] $SkipFetch
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. "$repoRoot/scripts/lib/Sync-Git.ps1"
. "$repoRoot/scripts/lib/Sync-GitHistory.ps1"
Set-SyncUtf8Environment

$config = Get-SyncConfig -RepoRoot $repoRoot
$work = Get-WorkDirectory -RepoRoot $repoRoot

Write-SyncLog 'Fetching mirrors'

foreach ($sourceKey in @('Ports', 'PortsMingw')) {
    $mirrorPath = Initialize-MirrorRepository `
        -WorkDirectory $work `
        -SourceKey $sourceKey `
        -Config $config `
        -SkipFetch:$SkipFetch
    $branch = $config.Sources.$sourceKey.Branch
    $tip = Get-MirrorTipSha -MirrorPath $mirrorPath -Branch $branch
    Write-SyncLog "$sourceKey mirror: $mirrorPath (tip $branch = $($tip.Substring(0, 8)))"
}

Write-SyncLog 'Done.'
exit 0
