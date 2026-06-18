#requires -Version 7.0

. "$PSScriptRoot/Sync-Common.ps1"
. "$PSScriptRoot/Sync-Config.ps1"

$script:EmptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

function Initialize-MirrorRepository {
    param(
        [Parameter(Mandatory)][string] $WorkDirectory,
        [Parameter(Mandatory)][string] $SourceId,
        [Parameter(Mandatory)] $SourceEntry,
        [switch] $SkipFetch
    )

    $mirrorRoot = Join-Path $WorkDirectory 'mirrors'
    if (-not (Test-Path -LiteralPath $mirrorRoot)) {
        New-Item -ItemType Directory -Path $mirrorRoot | Out-Null
    }

    $mirrorPath = Join-Path $mirrorRoot $SourceEntry.repo
    $url = Get-SourceCloneUrl -SourceEntry $SourceEntry

    if (-not (Test-Path -LiteralPath $mirrorPath)) {
        Write-SyncLog "Cloning mirror for $SourceId ($url)"
        $null = Invoke-Git -GitArgs @('clone', '--mirror', $url, $mirrorPath)
    }
    elseif (-not $SkipFetch) {
        Write-SyncLog "Fetching mirror for $SourceId"
        $null = Invoke-Git -RepoPath $mirrorPath -GitArgs @('fetch', '--prune', 'origin')
    }

    return $mirrorPath
}

function Initialize-DestinationRepository {
    param(
        [Parameter(Mandatory)][string] $WorkDirectory,
        [Parameter(Mandatory)] $Config,
        [string] $DestinationPath,
        [switch] $SkipFetch
    )

    if ($DestinationPath) {
        return (Resolve-Path -LiteralPath $DestinationPath).Path
    }

    $destRoot = Join-Path $WorkDirectory 'destination'
    if (-not (Test-Path -LiteralPath $destRoot)) {
        New-Item -ItemType Directory -Path $destRoot | Out-Null
    }

    $destPath = Join-Path $destRoot $Config.destination.repo
    $url = Get-DestinationCloneUrl -Config $Config

    if (-not (Test-Path -LiteralPath $destPath)) {
        Write-SyncLog "Cloning destination ($url)"
        $null = Invoke-Git -GitArgs @('clone', $url, $destPath)
    }
    elseif (-not $SkipFetch) {
        $null = Invoke-Git -RepoPath $destPath -GitArgs @('fetch', 'origin', '--prune')
    }

    return $destPath
}

function Initialize-DestinationAlternates {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)][string[]] $MirrorPaths
    )

    $alternatesDir = Join-Path $DestinationPath '.git/objects/info'
    if (-not (Test-Path -LiteralPath $alternatesDir)) {
        New-Item -ItemType Directory -Path $alternatesDir -Force | Out-Null
    }

    $normalized = foreach ($mirrorPath in $MirrorPaths) {
        $objectsPath = Join-Path (Resolve-Path -LiteralPath $mirrorPath).Path 'objects'
        if (Test-Path -LiteralPath $objectsPath) {
            ($objectsPath -replace '\\', '/')
        }
    }

    $alternatesFile = Join-Path $alternatesDir 'alternates'
    $text = (($normalized | Where-Object { $_ }) -join "`n") + "`n"
    [System.IO.File]::WriteAllText($alternatesFile, $text, [System.Text.UTF8Encoding]::new($false))
}

function Reset-DestinationBranch {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)] $Config,
        [string] $BranchName
    )

    $branch = if ($BranchName) { $BranchName } else { $Config.destination.branch }
    $base = $Config.destination.baseCommit

    Invoke-Git -RepoPath $DestinationPath -GitArgs @('checkout', '-B', $branch, $base) | Out-Null
    Invoke-Git -RepoPath $DestinationPath -GitArgs @('reset', '--hard', 'HEAD') | Out-Null
}

function Get-DestinationBranchTip {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)][string] $BranchName
    )

    return (Invoke-Git -RepoPath $DestinationPath -GitArgs @('rev-parse', $BranchName)).ToString().Trim()
}

function Test-CommitExists {
    param(
        [Parameter(Mandatory)][string] $RepoPath,
        [Parameter(Mandatory)][string] $Sha
    )

    $null = Invoke-Git -RepoPath $RepoPath -GitArgs @('cat-file', '-e', "${Sha}^{commit}")
    return $true
}

function Get-FirstParent {
    param(
        [Parameter(Mandatory)][string] $MirrorPath,
        [Parameter(Mandatory)][string] $Commit
    )

    $parents = Invoke-Git -RepoPath $MirrorPath -GitArgs @('rev-list', '--parents', '-n', '1', $Commit)
    $parts = $parents.ToString().Trim() -split '\s+'
    if ($parts.Count -le 1) {
        return $script:EmptyTree
    }
    return $parts[1]
}

function Get-UpstreamCommitEntries {
    param(
        [Parameter(Mandatory)][string] $MirrorPath,
        [Parameter(Mandatory)][string] $Branch,
        [string] $AfterSha,
        [string] $UntilSha
    )

    $range = if ($AfterSha) { "$AfterSha..$UntilSha" } else { $UntilSha }
    $format = '%H|%at|%ct'
    $lines = Invoke-Git -RepoPath $MirrorPath -GitArgs @(
        'log', '--reverse', "--format=$format", $range
    )

    $entries = @()
    foreach ($line in $lines) {
        $text = $line.ToString().Trim()
        if (-not $text) { continue }
        $parts = $text -split '\|'
        if ($parts.Count -lt 3) { continue }
        $entries += [pscustomobject]@{
            Sha = $parts[0]
            AuthorDate = [int64]$parts[1]
            CommitterDate = [int64]$parts[2]
        }
    }
    return $entries
}

function Get-CommitMetadata {
    param(
        [Parameter(Mandatory)][string] $MirrorPath,
        [Parameter(Mandatory)][string] $Commit
    )

    $raw = Invoke-GitText -RepoPath $MirrorPath -GitArgs @('cat-file', '-p', $Commit)
    return Parse-GitCommitObject -Raw $raw
}

function Format-ReplayCommitMessage {
    param(
        [Parameter(Mandatory)][string] $SortKey,
        [Parameter(Mandatory)] $Metadata,
        [Parameter(Mandatory)][string] $UpstreamRepo,
        [Parameter(Mandatory)][string] $UpstreamSha,
        [Parameter(Mandatory)][int] $ReplaySpecVersion
    )

    $subject = $Metadata.Subject
    $footer = "Source: ${UpstreamRepo}@${UpstreamSha}`nReplayed-By: msys-uwp-sync/${ReplaySpecVersion}"

    if ($Metadata.Body) {
        return ConvertTo-UnixLineEndings -Text "[${SortKey}] ${subject}`n`n$($Metadata.Body)`n`n$footer"
    }
    return ConvertTo-UnixLineEndings -Text "[${SortKey}] ${subject}`n`n$footer"
}

function Get-LsTreeEntries {
    param(
        [Parameter(Mandatory)][string] $MirrorPath,
        [Parameter(Mandatory)][string] $Treeish,
        [string] $PathPrefix
    )

    $args = @('ls-tree', '-r', '-z', $Treeish)
    if ($PathPrefix) { $args += '--' ; $args += $PathPrefix }
    $raw = Invoke-GitText -RepoPath $MirrorPath -GitArgs $args
    $tokens = $raw.Split([char]0, [StringSplitOptions]::RemoveEmptyEntries)

    $entries = @()
    foreach ($token in $tokens) {
        if ($token -match '^(\d+)\s(\S+)\s([0-9a-f]{40})\t(.+)$') {
            $entries += [pscustomobject]@{
                Mode = $Matches[1]
                Type = $Matches[2]
                Sha = $Matches[3]
                Path = $Matches[4]
            }
        }
    }
    return $entries
}

function Apply-UpstreamCommitToIndex {
    param(
        [Parameter(Mandatory)][string] $MirrorPath,
        [Parameter(Mandatory)][string] $Commit,
        [Parameter(Mandatory)][string] $Parent,
        [Parameter(Mandatory)][string] $DestSubdir,
        [Parameter(Mandatory)][string] $DestinationPath
    )

    $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('read-tree', 'HEAD')

    $parentEntries = @{}
    foreach ($entry in (Get-LsTreeEntries -MirrorPath $MirrorPath -Treeish $Parent)) {
        $parentEntries[$entry.Path] = $entry
    }

    $commitEntries = @{}
    foreach ($entry in (Get-LsTreeEntries -MirrorPath $MirrorPath -Treeish $Commit)) {
        $commitEntries[$entry.Path] = $entry
    }

    $allPaths = @($parentEntries.Keys + $commitEntries.Keys | Select-Object -Unique)
    $changed = $false

    foreach ($path in $allPaths) {
        $destPath = "$DestSubdir/$path"
        $inParent = $parentEntries.ContainsKey($path)
        $inCommit = $commitEntries.ContainsKey($path)

        if ($inParent -and $inCommit) {
            $p = $parentEntries[$path]
            $c = $commitEntries[$path]
            if ($p.Sha -eq $c.Sha -and $p.Mode -eq $c.Mode) {
                continue
            }
            Invoke-Git -RepoPath $DestinationPath -GitArgs @(
                'update-index', '--add', '--cacheinfo', $c.Mode, $c.Sha, $destPath
            )
            $changed = $true
        }
        elseif ($inCommit) {
            $c = $commitEntries[$path]
            Invoke-Git -RepoPath $DestinationPath -GitArgs @(
                'update-index', '--add', '--cacheinfo', $c.Mode, $c.Sha, $destPath
            )
            $changed = $true
        }
        else {
            Invoke-Git -RepoPath $DestinationPath -GitArgs @(
                'rm', '--cached', '-f', '--ignore-unmatch', '--', $destPath
            )
            $changed = $true
        }
    }

    return $changed
}

function New-ReplayCommit {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)] $Config,
        [Parameter(Mandatory)] $Metadata,
        [Parameter(Mandatory)][string] $Message
    )

    $authorDate = [DateTimeOffset]::FromUnixTimeSeconds($Metadata.AuthorDate).ToString('yyyy-MM-dd HH:mm:ss K')
    $env:GIT_AUTHOR_NAME = $Metadata.AuthorName
    $env:GIT_AUTHOR_EMAIL = $Metadata.AuthorEmail
    $env:GIT_AUTHOR_DATE = $authorDate
    $env:GIT_COMMITTER_NAME = $Config.replay.committerName
    $env:GIT_COMMITTER_EMAIL = $Config.replay.committerEmail
    $env:GIT_COMMITTER_DATE = $authorDate

    $messagePath = Join-Path ([System.IO.Path]::GetTempPath()) "sync-commit-$([Guid]::NewGuid().ToString('N')).txt"
    try {
        [System.IO.File]::WriteAllText($messagePath, $Message, [System.Text.UTF8Encoding]::new($false))
        $parent = (Invoke-Git -RepoPath $DestinationPath -GitArgs @('rev-parse', 'HEAD')).ToString().Trim()
        $tree = (Invoke-Git -RepoPath $DestinationPath -GitArgs @('write-tree')).ToString().Trim()
        $newCommit = (Invoke-Git -RepoPath $DestinationPath -GitArgs @(
            'commit-tree', $tree, '-p', $parent, '-F', $messagePath
        )).ToString().Trim()
        $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('update-ref', 'HEAD', $newCommit, $parent)
        $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('reset', '--hard', 'HEAD')
    }
    finally {
        Remove-Item -LiteralPath $messagePath -Force -ErrorAction SilentlyContinue
        Remove-Item Env:GIT_AUTHOR_NAME -ErrorAction SilentlyContinue
        Remove-Item Env:GIT_AUTHOR_EMAIL -ErrorAction SilentlyContinue
        Remove-Item Env:GIT_AUTHOR_DATE -ErrorAction SilentlyContinue
        Remove-Item Env:GIT_COMMITTER_NAME -ErrorAction SilentlyContinue
        Remove-Item Env:GIT_COMMITTER_EMAIL -ErrorAction SilentlyContinue
        Remove-Item Env:GIT_COMMITTER_DATE -ErrorAction SilentlyContinue
    }
}

function Get-TreeRootSha {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)][string] $BranchName,
        [Parameter(Mandatory)] $Config
    )

    $portsTree = 'empty'
    $mingwTree = 'empty'
    $portsSub = $Config.sources.ports.destSubdir
    $mingwSub = $Config.sources.'ports-mingw'.destSubdir

    try {
        $portsTree = (Invoke-Git -RepoPath $DestinationPath -GitArgs @(
            'rev-parse', "${BranchName}:${portsSub}"
        )).ToString().Trim()
    }
    catch { }

    try {
        $mingwTree = (Invoke-Git -RepoPath $DestinationPath -GitArgs @(
            'rev-parse', "${BranchName}:${mingwSub}"
        )).ToString().Trim()
    }
    catch { }

    return "${portsTree}-${mingwTree}"
}

function Sort-ReplayCommitQueue {
    param(
        [Parameter(Mandatory)][object[]] $Queue
    )

    return $Queue | Sort-Object -Property @(
        @{ Expression = { $_.AuthorDate } },
        @{ Expression = { $_.CommitterDate } },
        @{ Expression = { $_.SortKey } },
        @{ Expression = { $_.Sha } }
    )
}
