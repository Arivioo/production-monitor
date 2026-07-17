<#
  Registers the "AgentTriage-LocalRunner" Windows Scheduled Task on Roger's always-on desktop.

  Every 20 minutes it runs scripts/local-triage-runner.mjs, which checks the cloud
  production-monitor for an unresolved failure and, if found, triages it LOCALLY via the Claude
  Code CLI authed by Roger's subscription — so remediation costs NO API credits. The cloud/API
  triage in monitor.yml stays disabled (repo var AGENT_TRIAGE_ENABLED=0) as a fallback for when
  the desktop is off.

  Runs in Roger's user context (Interactive logon) so it inherits his ~/.claude.json subscription
  auth and gh credentials. Re-run this script any time to update the task. Remove with:
    Unregister-ScheduledTask -TaskName "AgentTriage-LocalRunner" -Confirm:$false
#>
$ErrorActionPreference = 'Stop'

$taskName = 'AgentTriage-LocalRunner'
$node     = (Get-Command node).Source
$runner   = 'C:\Business\Internal Projects\production-monitor\scripts\local-triage-runner.mjs'

if (-not (Test-Path $runner)) { throw "Runner not found: $runner" }

$action = New-ScheduledTaskAction -Execute $node -Argument ('"{0}"' -f $runner)

# -Once + repetition every 20 min, effectively forever. Copy the Repetition object from a
# repetition-configured trigger (the reliable way around a PowerShell quirk where the interval
# otherwise doesn't stick).
$start   = (Get-Date).AddMinutes(2)
$trigger = New-ScheduledTaskTrigger -Once -At $start
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At $start `
    -RepetitionInterval (New-TimeSpan -Minutes 20) `
    -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition

$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Local-first auto-remediation: every 20 min, triage any unresolved production-monitor failure on the Claude subscription (no API cost). Cloud API triage is the fallback.' | Out-Null

Write-Output "Registered task '$taskName' (every 20 min, next ~$start)."
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State | Format-Table -AutoSize
