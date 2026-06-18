#requires -Version 7.0
[CmdletBinding()]
param(
    [string] $DestinationPath,
    [switch] $DryRun
)

& "$PSScriptRoot/Sync-Upstream.ps1" `
    -Mode Verify `
    -DestinationPath $DestinationPath `
    -DryRun:$DryRun

exit $LASTEXITCODE
