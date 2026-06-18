#requires -Version 7.0
[CmdletBinding()]
param(
    [string] $DestinationPath,
    [int] $MaxCommits = 0,
    [switch] $DryRun,
    [switch] $Force,
    [switch] $PushDestination
)

& "$PSScriptRoot/Sync-Upstream.ps1" `
    -Mode Incremental `
    -DestinationPath $DestinationPath `
    -MaxCommits $MaxCommits `
    -DryRun:$DryRun `
    -Force:$Force `
    -PushDestination:$PushDestination `
    -PushState:$PushDestination.IsPresent

exit $LASTEXITCODE
