#requires -Version 7.0
<#
.SYNOPSIS
    Merge ports and ports-mingw histories by replay rank.

.PARAMETER SaveFullJson
    Write every merged queue entry to merged-queue-full.json (can be large).
#>
[CmdletBinding()]
param(
    [switch] $SkipFetch,
    [string] $AfterSha,
    [switch] $SaveFullJson,
    [int] $SampleCount = 5
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. "$repoRoot/scripts/lib/Sync-GitQueue.ps1"
. "$repoRoot/scripts/lib/Sync-GitHistory.ps1"
. "$repoRoot/scripts/lib/Sync-Git.ps1"
Set-SyncUtf8Environment

$config = Get-SyncConfig -RepoRoot $repoRoot
$work = Get-WorkDirectory -RepoRoot $repoRoot
$outDir = Join-Path $work 'cache/replay-log'
if (-not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

Write-SyncLog "Merging queue (after=$(if ($AfterSha) { $AfterSha.Substring(0, 8) } else { 'full' }))"

$mirrorPorts = Initialize-MirrorRepository -WorkDirectory $work -SourceKey Ports -Config $config -SkipFetch:$SkipFetch
$mirrorMingw = Initialize-MirrorRepository -WorkDirectory $work -SourceKey PortsMingw -Config $config -SkipFetch:$SkipFetch

$tipPorts = Get-MirrorTipSha -MirrorPath $mirrorPorts -Branch $config.Sources.Ports.Branch
$tipMingw = Get-MirrorTipSha -MirrorPath $mirrorMingw -Branch $config.Sources.PortsMingw.Branch

$portsList = Get-SourceReplayHistory `
    -SourceKey Ports -Config $config -MirrorPath $mirrorPorts `
    -AfterSha $AfterSha -UntilSha $tipPorts

$mingwList = Get-SourceReplayHistory `
    -SourceKey PortsMingw -Config $config -MirrorPath $mirrorMingw `
    -AfterSha $AfterSha -UntilSha $tipMingw

$queue = Merge-ReplayCommitQueues -PortsList $portsList -PortsMingwList $mingwList

Write-SyncLog "ports: $($portsList.Count)  mingw: $($mingwList.Count)  merged: $($queue.Count)"

$queue | Select-Object -First $SampleCount | Format-Table SourceId, Sha, CommitterDateUnix, Subject -AutoSize

$outFile = Join-Path $outDir 'merged-queue-summary.json'
$fullFile = if ($SaveFullJson) { Join-Path $outDir 'merged-queue-full.json' } else { $null }

if ($SaveFullJson) {
    @($queue | ForEach-Object {
        [ordered]@{
            Sha = $_.Sha
            SourceId = $_.SourceId
            CommitterDateUnix = $_.CommitterDateUnix
            AuthorDateUnix = $_.AuthorDateUnix
            AuthorName = $_.AuthorName
            AuthorEmail = $_.AuthorEmail
            CommitterName = $_.CommitterName
            CommitterEmail = $_.CommitterEmail
            Subject = $_.Subject
            Body = $_.Body
        }
    }) | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $fullFile -Encoding utf8
}

[ordered]@{
    PortsCount = $portsList.Count
    PortsMingwCount = $mingwList.Count
    MergedCount = $queue.Count
    FullHistoryFile = $fullFile
    Sample = @($queue | Select-Object -First $SampleCount | ForEach-Object {
        [ordered]@{
            SourceId = $_.SourceId
            Sha = $_.Sha
            CommitterDateUnix = $_.CommitterDateUnix
            Subject = $_.Subject
        }
    })
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $outFile -Encoding utf8
Write-SyncLog "summary -> $outFile"
if ($SaveFullJson) {
    Write-SyncLog "full queue -> $fullFile"
}

Write-SyncLog 'Done.'
exit 0
