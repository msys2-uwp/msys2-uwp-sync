#requires -Version 7.0
<#
.SYNOPSIS
    Retrieve upstream commit history from mirror(s).

.PARAMETER SourceKey
    Ports, PortsMingw, or Both (default Both).

.PARAMETER AfterSha
    Cursor SHA (last replayed upstream commit). Omit for full history.

.PARAMETER SkipFetch
    Skip mirror fetch (use existing .work/mirrors clone).

.PARAMETER SaveFullJson
    Write every commit entry to history-<sortKey>-full.json (can be large).
#>
[CmdletBinding()]
param(
    [ValidateSet('Ports', 'PortsMingw', 'Both')]
    [string] $SourceKey = 'Both',
    [string] $AfterSha,
    [switch] $SkipFetch,
    [switch] $SaveFullJson,
    [int] $SampleCount = 3
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. "$repoRoot/scripts/lib/Sync-GitHistory.ps1"
. "$repoRoot/scripts/lib/Sync-Git.ps1"
Set-SyncUtf8Environment

$config = Get-SyncConfig -RepoRoot $repoRoot
$work = Get-WorkDirectory -RepoRoot $repoRoot
$outDir = Join-Path $work 'cache/replay-log'
if (-not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$sourceKeys = if ($SourceKey -eq 'Both') { @('Ports', 'PortsMingw') } else { @($SourceKey) }

Write-SyncLog "Retrieving history (sources=$SourceKey after=$(if ($AfterSha) { $AfterSha.Substring(0, 8) } else { 'full' }))"

foreach ($key in $sourceKeys) {
    $mirrorPath = Initialize-MirrorRepository `
        -WorkDirectory $work `
        -SourceKey $key `
        -Config $config `
        -SkipFetch:$SkipFetch
    $branch = $config.Sources.$key.Branch
    $tip = Get-MirrorTipSha -MirrorPath $mirrorPath -Branch $branch

    $history = Get-SourceReplayHistory `
        -SourceKey $key `
        -Config $config `
        -MirrorPath $mirrorPath `
        -AfterSha $AfterSha `
        -UntilSha $tip

    $sortKey = $config.Sources.$key.SortKey
    $outFile = Join-Path $outDir "history-$sortKey.json"
    $fullFile = if ($SaveFullJson) { Join-Path $outDir "history-$sortKey-full.json" } else { $null }

    if ($SaveFullJson) {
        @($history | ForEach-Object {
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
        SourceKey = $key
        SortKey = $sortKey
        MirrorPath = $mirrorPath
        AfterSha = $AfterSha
        UntilSha = $tip
        Count = $history.Count
        OldestSha = if ($history.Count -gt 0) { $history[0].Sha } else { $null }
        NewestSha = if ($history.Count -gt 0) { $history[-1].Sha } else { $null }
        FullHistoryFile = $fullFile
        Sample = @($history | Select-Object -First $SampleCount | ForEach-Object {
            [ordered]@{
                Sha = $_.Sha
                CommitterDateUnix = $_.CommitterDateUnix
                Subject = $_.Subject
            }
        })
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $outFile -Encoding utf8

    Write-SyncLog "${sortKey}: $($history.Count) commit(s) ($($tip.Substring(0, 8)) tip) -> $outFile"
    if ($SaveFullJson) {
        Write-SyncLog "  full history -> $fullFile"
    }
    if ($history.Count -gt 0) {
        Write-SyncLog "  oldest: $($history[0].Sha.Substring(0,8)) $($history[0].Subject)"
        Write-SyncLog "  newest: $($history[-1].Sha.Substring(0,8)) $($history[-1].Subject)"
    }
}

Write-SyncLog 'Done.'
exit 0
