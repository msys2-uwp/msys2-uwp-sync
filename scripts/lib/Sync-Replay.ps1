#requires -Version 7.0

. "$PSScriptRoot/Sync-Common.ps1"
. "$PSScriptRoot/Sync-Config.ps1"
. "$PSScriptRoot/Sync-State.ps1"
. "$PSScriptRoot/Sync-Manifest.ps1"
. "$PSScriptRoot/Sync-GitHub.ps1"
. "$PSScriptRoot/Sync-Git.ps1"

function Start-ReplaySync {
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [Parameter(Mandatory)][ValidateSet('Bootstrap', 'Incremental', 'Rebuild', 'Verify')]
        [string] $Mode,
        [string] $DestinationPath,
        [string] $BranchName,
        [int] $MaxCommits = 0,
        [switch] $DryRun,
        [switch] $SkipFetch,
        [switch] $Force
    )

    $config = Get-SyncConfig -RepoRoot $RepoRoot
    $state = Get-SyncState -RepoRoot $RepoRoot
    $workDirectory = Get-WorkDirectory -RepoRoot $RepoRoot
    $branch = if ($BranchName) { $BranchName } else { $config.destination.branch }
    $resetBranch = $Mode -in @('Bootstrap', 'Rebuild', 'Verify')

    $mirrors = @{}
    foreach ($prop in $config.sources.PSObject.Properties) {
        $mirrors[$prop.Name] = Initialize-MirrorRepository `
            -WorkDirectory $workDirectory `
            -SourceId $prop.Name `
            -SourceEntry $prop.Value `
            -SkipFetch:$SkipFetch
    }

    $destPath = Initialize-DestinationRepository `
        -WorkDirectory $workDirectory `
        -Config $config `
        -DestinationPath $DestinationPath `
        -SkipFetch:$SkipFetch

    Initialize-DestinationAlternates -DestinationPath $destPath -MirrorPaths @($mirrors.Values)

    $baseCommit = $config.destination.baseCommit
    $null = Test-CommitExists -RepoPath $destPath -Sha $baseCommit

    if ($resetBranch) {
        Reset-DestinationBranch -DestinationPath $destPath -Config $config -BranchName $branch
    }
    else {
        $branchExists = $true
        try {
            $null = Invoke-Git -RepoPath $destPath -GitArgs @('rev-parse', '--verify', $branch)
        }
        catch {
            $branchExists = $false
        }

        if (-not $branchExists) {
            Reset-DestinationBranch -DestinationPath $destPath -Config $config -BranchName $branch
        }
        else {
            Invoke-Git -RepoPath $destPath -GitArgs @('checkout', $branch)
        }
    }

    $upstreamTips = @{}
    $queue = @()

    foreach ($prop in $config.sources.PSObject.Properties) {
        $sourceId = $prop.Name
        $sourceEntry = $prop.Value
        $mirrorPath = $mirrors[$sourceId]
        $branchRef = "refs/heads/$($sourceEntry.branch)"
        $tip = (Invoke-Git -RepoPath $mirrorPath -GitArgs @('rev-parse', $branchRef)).ToString().Trim()
        $upstreamTips[$sourceId] = $tip

        $afterSha = if ($resetBranch) { $null } else { Get-SourceCursor -State $state -SourceId $sourceId }
        if ($afterSha) {
            $null = Test-CommitExists -RepoPath $mirrorPath -Sha $afterSha
        }

        $entries = Get-UpstreamCommitEntries -MirrorPath $mirrorPath -Branch $tip -AfterSha $afterSha -UntilSha $tip
        foreach ($entry in $entries) {
            $queue += [pscustomobject]@{
                SourceId = $sourceId
                SortKey = $sourceEntry.sortKey
                DestSubdir = $sourceEntry.destSubdir
                UpstreamRepo = Get-SourceRepoSlug -SourceEntry $sourceEntry
                MirrorPath = $mirrorPath
                Sha = $entry.Sha
                AuthorDate = $entry.AuthorDate
                CommitterDate = $entry.CommitterDate
            }
        }
    }

    if ($Mode -eq 'Incremental' -and -not $Force) {
        $currentTips = Get-AllUpstreamTips -Config $config
        if (-not (Test-UpstreamChanged -State $state -CurrentTips $currentTips) -and $queue.Count -eq 0) {
            Write-SyncLog 'No upstream changes detected; skipping replay.'
            return [pscustomobject]@{
                CommitsReplayed = 0
                Skipped = $true
                DestinationPath = $destPath
                BranchName = $branch
                UpstreamTips = $upstreamTips
            }
        }
    }

    $queue = @(Sort-ReplayCommitQueue -Queue $queue)
    if ($MaxCommits -gt 0 -and $queue.Count -gt $MaxCommits) {
        $queue = $queue[0..($MaxCommits - 1)]
    }

    Write-SyncLog "Replay mode=$Mode branch=$branch pending=$($queue.Count) commits"

    $replayed = 0
    $index = 0

    foreach ($item in $queue) {
        $index++
        $parent = Get-FirstParent -MirrorPath $item.MirrorPath -Commit $item.Sha
        $metadata = Get-CommitMetadata -MirrorPath $item.MirrorPath -Commit $item.Sha
        $message = Format-ReplayCommitMessage `
            -SortKey $item.SortKey `
            -Metadata $metadata `
            -UpstreamRepo $item.UpstreamRepo `
            -UpstreamSha $item.Sha `
            -ReplaySpecVersion $config.replaySpecVersion

        $hasChanges = Apply-UpstreamCommitToIndex `
            -MirrorPath $item.MirrorPath `
            -Commit $item.Sha `
            -Parent $parent `
            -DestSubdir $item.DestSubdir `
            -DestinationPath $destPath

        if (-not $hasChanges -and $config.replay.skipEmptyTreeDiff) {
            Write-SyncLog "[$($item.SortKey)] skip empty diff $($item.Sha.Substring(0, 7))"
            if (-not $DryRun) {
                Set-SourceCursor -State $state -SourceId $item.SourceId -Sha $item.Sha
            }
            continue
        }

        if ($DryRun) {
            Write-SyncLog "[$($item.SortKey)] dry-run would replay $($item.Sha.Substring(0, 7)) $($metadata.Subject)"
        }
        else {
            New-ReplayCommit -DestinationPath $destPath -Config $config -Metadata $metadata -Message $message
            Set-SourceCursor -State $state -SourceId $item.SourceId -Sha $item.Sha
            $replayed++
            if ($index % 100 -eq 0) {
                Write-SyncLog "Progress: $index / $($queue.Count) ($replayed replayed)"
            }
        }
    }

    $tipSha = Get-DestinationBranchTip -DestinationPath $destPath -BranchName $branch
    $treeRootSha = Get-TreeRootSha -DestinationPath $destPath -BranchName $branch -Config $config

    if (-not $DryRun) {
        Update-LastUpstreamCheck -State $state -Tips $upstreamTips
        $state.destinationBranchTip = $tipSha
        $state.lastSyncAt = (Get-Date).ToUniversalTime().ToString('o')
    }

    return [pscustomobject]@{
        CommitsReplayed = $replayed
        Skipped = $false
        DestinationPath = $destPath
        BranchName = $branch
        DestinationTipSha = $tipSha
        TreeRootSha = $treeRootSha
        UpstreamTips = $upstreamTips
        State = $state
        Config = $config
    }
}

function Complete-ReplaySync {
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [Parameter(Mandatory)] $Result,
        [Parameter(Mandatory)][ValidateSet('Bootstrap', 'Incremental', 'Rebuild', 'Verify')]
        [string] $Mode,
        [switch] $DryRun,
        [switch] $PushDestination,
        [switch] $PushState
    )

    if ($DryRun) {
        Write-SyncLog "Dry run complete; replayed $($Result.CommitsReplayed) commits."
        return
    }

    $manifest = New-ReplayManifest `
        -Config $Result.Config `
        -UpstreamPins $Result.UpstreamTips `
        -CommitCount 0 `
        -DestinationTipSha $Result.DestinationTipSha `
        -TreeRootSha $Result.TreeRootSha

    $countOutput = (Invoke-Git -RepoPath $Result.DestinationPath -GitArgs @(
        'rev-list', '--count', "$($Result.Config.destination.baseCommit)..$($Result.BranchName)"
    )).ToString().Trim()
    $manifest.commitCount = [int]$countOutput

    if ($Mode -eq 'Rebuild') {
        $existing = Get-ReplayManifest -RepoRoot $RepoRoot
        if ($existing.destinationTipSha) {
            $compare = Compare-ReplayManifest -Expected $existing -Actual $manifest
            if (-not $compare.Match) {
                throw "Rebuild manifest mismatch on $($compare.Field): expected '$($compare.Expected)' actual '$($compare.Actual)'"
            }
            Write-SyncLog 'Rebuild manifest matches expected tip.'
        }
    }

    Save-ReplayManifest -RepoRoot $RepoRoot -Manifest $manifest
    $Result.State.replayManifestSha = Get-ManifestContentHash -RepoRoot $RepoRoot
    Save-SyncState -RepoRoot $RepoRoot -State $Result.State

    if ($PushDestination -and ($Result.CommitsReplayed -gt 0 -or $Mode -eq 'Rebuild')) {
        Write-SyncLog "Pushing destination branch $($Result.BranchName)"
        $pushArgs = @('push', 'origin', "$($Result.BranchName):$($Result.Config.destination.branch)")
        if ($Mode -eq 'Rebuild') {
            $pushArgs = @('push', '--force-with-lease', 'origin', "$($Result.BranchName):$($Result.Config.destination.branch)")
        }
        Invoke-Git -RepoPath $Result.DestinationPath -GitArgs $pushArgs
    }

    if ($PushState) {
        Write-SyncLog 'State and manifest updated locally (push from CI).'
    }

    Write-SyncLog "Sync complete; replayed $($Result.CommitsReplayed) commits; tip=$($Result.DestinationTipSha)"
}

function Invoke-RebuildVerify {
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [string] $DestinationPath,
        [switch] $DryRun
    )

    $expected = Get-ReplayManifest -RepoRoot $RepoRoot
    if (-not $expected.destinationTipSha) {
        Write-SyncLog 'No prior manifest tip recorded; running rebuild without compare.' -Level Warn
    }

    $result = Start-ReplaySync `
        -RepoRoot $RepoRoot `
        -Mode 'Verify' `
        -DestinationPath $DestinationPath `
        -BranchName "upstream-verify-$(Get-Date -Format 'yyyyMMddHHmmss')" `
        -DryRun:$DryRun

    $actual = New-ReplayManifest `
        -Config $result.Config `
        -UpstreamPins $result.UpstreamTips `
        -CommitCount 0 `
        -DestinationTipSha $result.DestinationTipSha `
        -TreeRootSha $result.TreeRootSha

    $countOutput = (Invoke-Git -RepoPath $result.DestinationPath -GitArgs @(
        'rev-list', '--count', "$($result.Config.destination.baseCommit)..$($result.BranchName)"
    )).ToString().Trim()
    $actual.commitCount = [int]$countOutput

    if ($expected.destinationTipSha) {
        $compare = Compare-ReplayManifest -Expected $expected -Actual $actual
        if (-not $compare.Match) {
            throw "Manifest mismatch on field $($compare.Field): expected '$($compare.Expected)' actual '$($compare.Actual)'"
        }
        Write-SyncLog 'Manifest verification passed.'
    }

    return $result
}
