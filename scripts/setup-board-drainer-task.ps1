<#
  Registers the "Board-Drainer-LocalRunner" Windows Scheduled Task on Roger's always-on desktop.

  STAGE 6 — GO-LIVE APPROVED by Roger 2026-08-18. This script now registers the task LIVE
  (BOARD_DRAINER_LIVE=1): the drainer actually dispatches fixes and writes back to the board.

  Every 20 minutes it runs scripts/board-drainer.mjs, which reads the cockpit Monitoring Board
  (monitoring_incidents), re-verifies every open incident against the live system, FIXES the
  owner=Claude items an autonomous dev session may safely handle (monitor/spec/CI/config/pipeline;
  staging deploy for product code), NOTES plan-expired/expected-business-state rows as
  status=expected (muted, not open), auto-CLOSES self-healed false-reds (any owner) with a receipt,
  and ESCALATES the rest to Roger. Runs on the Claude subscription (no API cost), same interactive
  logon as AgentTriage-LocalRunner so it inherits ~/.claude.json auth + gh credentials.

  SAFETY: board-drainer.mjs self-skips unless BOARD_DRAINER_ENABLED=1, and only ACTS when
  BOARD_DRAINER_LIVE=1. This task registers it ENABLED and LIVE. To go back to supervised dry-run,
  remove the BOARD_DRAINER_LIVE set from $cmd below and re-run. Kill switch: machine env
  BOARD_DRAINER_DISABLED=1, or Disable-ScheduledTask -TaskName Board-Drainer-LocalRunner.

  Remove with: Unregister-ScheduledTask -TaskName "Board-Drainer-LocalRunner" -Confirm:$false
#>
$ErrorActionPreference = 'Stop'

$taskName = 'Board-Drainer-LocalRunner'
$node     = (Get-Command node).Source
$runner   = 'C:\Business\Internal Projects\production-monitor\scripts\board-drainer.mjs'

if (-not (Test-Path $runner)) { throw "Runner not found: $runner" }

# ENABLED and LIVE (go-live approved 2026-08-18): the drainer dispatches fixes and writes back.
# To return to supervised dry-run, drop the BOARD_DRAINER_LIVE set below and re-run this script.
# NOTE: quote the set assignments (set "VAR=1") — an unquoted 'set VAR=1 &&' captures the trailing
# space into the value ("1 "), which fails the ==='1' check and silently self-skips.
$cmd = ('/c set "BOARD_DRAINER_ENABLED=1" && set "BOARD_DRAINER_LIVE=1" && "{0}" "{1}"' -f $node, $runner)
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmd

$start   = (Get-Date).AddMinutes(2)
$trigger = New-ScheduledTaskTrigger -Once -At $start
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At $start `
    -RepetitionInterval (New-TimeSpan -Minutes 20) `
    -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition

# Battery gates MUST be off (AUTOMATIONS_RUNBOOK.md birth-certificate item 5). These were
# MISSING: audited 2026-08-20, this task had DisallowStartIfOnBatteries=True and
# StopIfGoingOnBatteries=True while its three sibling runners (AgentTriage, DeployTriage,
# Needs-Roger Closer) all had them False. New-ScheduledTaskSettingsSet defaults them to True,
# which is exactly how the brain tasks silently skipped for days on 2026-08-10. A drainer that
# skips looks identical to a clean board.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Board Drainer: every 20 min, re-verify every open Monitoring Board incident; fix owner=Claude items, note expected business state as status=expected, auto-close self-healed false-reds with a receipt, escalate the rest. Subscription auth, no API cost. LIVE since 2026-08-18 (go-live approved); drop BOARD_DRAINER_LIVE=1 to revert to dry-run.' | Out-Null

Write-Output "Registered task '$taskName' (every 20 min, next ~$start). LIVE (BOARD_DRAINER_LIVE=1)."
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State | Format-Table -AutoSize
