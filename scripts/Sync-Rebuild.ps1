#requires -Version 7.0
[CmdletBinding()]
param(
    [string] $DestinationPath,
    [int] $MaxCommits = 0,
    [switch] $DryRun,
    [switch] $PushDestination
)

& "$PSScriptRoot/Sync-Upstream.ps1" `
    -Mode Rebuild `
    -DestinationPath $DestinationPath `
    -MaxCommits $MaxCommits `
    -DryRun:$DryRun `
    -PushDestination:$PushDestination `
    -PushState:$PushDestination.IsPresent

exit $LASTEXITCODE
