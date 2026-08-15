<#
  Registers the "Board-Drainer-LocalRunner" Windows Scheduled Task on Roger's always-on desktop.

  STAGE 6 — DO NOT RUN THIS UNTIL ROGER HAS REVIEWED. Registering it is the go-live step.

  Every 20 minutes it runs scripts/board-drainer.mjs, which reads the cockpit Monitoring Board
  (monitoring_incidents), re-verifies every open incident against the live system, FIXES the
  owner=Claude items an autonomous dev session may safely handle (monitor/spec/CI/config/pipeline;
  staging deploy for product code), auto-CLOSES self-healed false-reds (any owner) with a receipt,
  and ESCALATES the rest to Roger. Runs on the Claude subscription (no API cost), same interactive
  logon as AgentTriage-LocalRunner so it inherits ~/.claude.json auth + gh credentials.

  SAFETY: board-drainer.mjs self-skips unless BOARD_DRAINER_ENABLED=1, and only ACTS when
  BOARD_DRAINER_LIVE=1. This task registers it ENABLED but NOT LIVE by default — first cycles are
  dry-run (classify + log only) for supervised review. Flip to live by adding BOARD_DRAINER_LIVE=1
  after the dry-run classifications look right. Kill switch: machine env BOARD_DRAINER_DISABLED=1,
  or Disable-ScheduledTask -TaskName Board-Drainer-LocalRunner.

  Remove with: Unregister-ScheduledTask -TaskName "Board-Drainer-LocalRunner" -Confirm:$false
#>
$ErrorActionPreference = 'Stop'

$taskName = 'Board-Drainer-LocalRunner'
$node     = (Get-Command node).Source
$runner   = 'C:\Business\Internal Projects\production-monitor\scripts\board-drainer.mjs'

if (-not (Test-Path $runner)) { throw "Runner not found: $runner" }

# ENABLED but NOT LIVE for the supervised first cycles (dry-run: classify + log only, touches nothing).
# After review, add 'set "BOARD_DRAINER_LIVE=1" &&' to go live.
# NOTE: quote the set assignments (set "VAR=1") — an unquoted 'set VAR=1 &&' captures the trailing
# space into the value ("1 "), which fails the ==='1' check and silently self-skips.
$cmd = ('/c set "BOARD_DRAINER_ENABLED=1" && "{0}" "{1}"' -f $node, $runner)
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmd

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
    -Description 'Board Drainer: every 20 min, re-verify every open Monitoring Board incident; fix owner=Claude items, auto-close self-healed false-reds with a receipt, escalate the rest. Subscription auth, no API cost. Starts dry-run; add BOARD_DRAINER_LIVE=1 after supervised review.' | Out-Null

Write-Output "Registered task '$taskName' (every 20 min, next ~$start). DRY-RUN until BOARD_DRAINER_LIVE=1 is added."
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State | Format-Table -AutoSize
