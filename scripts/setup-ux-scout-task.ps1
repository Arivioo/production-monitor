<#
  Registers the "UX-Scout-LocalRunner" Windows Scheduled Task on Roger's always-on desktop.

  WHAT IT IS: the PROACTIVE half of the agent tier. Everything else we run wakes only when a
  check somebody already wrote goes red; the hourly production check literally prints
  "GREEN, nothing to do" and stops. This runs on a GREEN board, on purpose. Weekly it reads
  each product's own failure log on its PRODUCTION ref (parsed out of that repo's deploy.yml
  at runtime, never hardcoded), separates failures that hit an AUTHENTICATED user from
  anonymous probes against public function URLs, and files each as a REPORT in BackOffice
  `scout_reports`.

  AUTONOMY: none. It is READ-ONLY against every product database. It writes to exactly one
  table (scout_reports), opens no PR, deploys nothing, touches no product code, and never
  files into monitoring_incidents, so it can never create paging work. Reports are free;
  alarms are not. Promotion of a report to an actual fix is a separate, human-gated phase.

  COST: one small headless `claude` call per week, and only when a real user actually hit
  something. A quiet week makes no model call and sends no email.

  SAFETY: ux-scout.mjs self-skips unless UX_SCOUT_ENABLED=1, and only WRITES when
  UX_SCOUT_LIVE=1. Pass -DryRun to register it in supervised read-only mode.
  Kill switch: machine env UX_SCOUT_DISABLED=1, or
  Disable-ScheduledTask -TaskName UX-Scout-LocalRunner.

  ALARM (birth certificate): a run that throws emails Roger via send_report_email.py with
  subject "[ALERT] UX Scout run failed". Silent-stop is covered by the sibling runners on
  this same box (agenttriage / needs-roger-closer / board-drainer), whose dead-man checks
  page if the machine goes dark. No dedicated healthchecks slot: the free plan is at its
  check limit (verified 2026-08-15). If a slot frees, set env UX_SCOUT_HC.

  Remove with: Unregister-ScheduledTask -TaskName "UX-Scout-LocalRunner" -Confirm:$false
#>
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'

$taskName = 'UX-Scout-LocalRunner'
$node     = (Get-Command node).Source
$runner   = 'C:\Business\Internal Projects\production-monitor\scripts\ux-scout.mjs'

if (-not (Test-Path $runner)) { throw "Runner not found: $runner" }

# NOTE: quote the set assignments (set "VAR=1"). An unquoted 'set VAR=1 &&' captures the
# trailing space into the value ("1 "), which fails the ==='1' check and silently self-skips.
# That exact bug is why the Board Drainer script carries the same comment.
if ($DryRun) {
    $cmd = ('/c set "UX_SCOUT_ENABLED=1" && "{0}" "{1}"' -f $node, $runner)
    $mode = 'DRY-RUN (reads and classifies, writes nothing)'
} else {
    $cmd = ('/c set "UX_SCOUT_ENABLED=1" && set "UX_SCOUT_LIVE=1" && "{0}" "{1}"' -f $node, $runner)
    $mode = 'LIVE (writes scout_reports, emails a digest when a real user hit something)'
}
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmd

# Weekly, Monday 07:20. Deliberately BEFORE the 07:40 Google-issues check and after the
# 07:00/07:10 brain jobs, so the week opens with "did any real user hit a wall" already
# answered rather than competing with the daily noise.
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 07:20

# Battery gates MUST be off. New-ScheduledTaskSettingsSet defaults DisallowStartIfOnBatteries
# and StopIfGoingOnBatteries to TRUE, which is how the brain tasks silently skipped for days
# (AUTOMATIONS_RUNBOOK.md birth-certificate item 5, 2026-08-10). A weekly task that skips is
# indistinguishable from a quiet week, which is the one failure this tool must not have.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'UX Scout: weekly Mon 07:20. Reads each product PROD failure log, separates authenticated user pain from anonymous probes, files reports into BackOffice scout_reports. READ-ONLY against products, no PRs, no deploys, never pages. Kill: UX_SCOUT_DISABLED=1.' | Out-Null

Write-Output "Registered task '$taskName' (weekly Mon 07:20). Mode: $mode"
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State | Format-Table -AutoSize
