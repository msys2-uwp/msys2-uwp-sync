#requires -Version 7.0
[CmdletBinding()]
param(
    [string] $DestinationPath,
    [int] $MaxCommits = 0,
    [switch] $DryRun,
    [switch] $PushDestination
)

& "$PSScriptRoot/Sync-Upstream.ps1" `
    -Mode Bootstrap `
    -DestinationPath $DestinationPath `
    -MaxCommits $MaxCommits `
    -DryRun:$DryRun `
    -PushDestination:$PushDestination `
    -PushState:$PushDestination.IsPresent

exit $LASTEXITCODE
