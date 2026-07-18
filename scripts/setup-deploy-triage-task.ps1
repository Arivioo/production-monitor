<#
  Registers the "DeployTriage-LocalRunner" Windows Scheduled Task on Roger's always-on desktop.

  Every 30 minutes it runs scripts/deploy-failure-triage.mjs, which polls the fleet's deploy
  pipelines (deploy.yml) and, for any CURRENT code failure (build/typecheck/unit/gate-e2e) on the
  branch HEAD, spawns a headless Claude agent that diagnoses the root cause and opens a PR on the
  target repo with a fix — never auto-shipping. Runs LOCALLY via the Claude Code CLI authed by
  Roger's subscription (DEPLOY_TRIAGE_LOCAL=1), so it costs NO API credits.

  Companion to AgentTriage-LocalRunner (which handles live-site MONITOR failures). This one handles
  the deploy PIPELINE surface. Both are local-first; the cloud/API path stays dormant.

  Runs in Roger's user context (Interactive logon) so it inherits his ~/.claude.json subscription
  auth and gh credentials. Re-run this script any time to update the task. Remove with:
    Unregister-ScheduledTask -TaskName "DeployTriage-LocalRunner" -Confirm:$false

  Kill-switch (no un-registering needed): set a machine env var DEPLOY_TRIAGE_DISABLED=1.
#>
$ErrorActionPreference = 'Stop'

$taskName = 'DeployTriage-LocalRunner'
$node     = (Get-Command node).Source
$runner   = 'C:\Business\Internal Projects\production-monitor\scripts\deploy-failure-triage.mjs'

if (-not (Test-Path $runner)) { throw "Runner not found: $runner" }

# The orchestrator honours the PAID-KEY GATE: it runs only when DEPLOY_TRIAGE_ENABLED=1 AND
# (DEPLOY_TRIAGE_LOCAL=1 subscription OR an API key). Set both via a cmd wrapper so the task itself
# carries the on-switch + the free/local flag. DEPLOY_TRIAGE_DISABLED=1 (machine env) still no-ops it.
$cmd  = (Get-Command cmd.exe).Source
$args = ('/c set "DEPLOY_TRIAGE_ENABLED=1" && set "DEPLOY_TRIAGE_LOCAL=1" && "{0}" "{1}"' -f $node, $runner)
$action = New-ScheduledTaskAction -Execute $cmd -Argument $args

# -Once + repetition every 30 min, effectively forever (same PowerShell-quirk workaround as the
# monitor runner: copy the Repetition object from a repetition-configured trigger).
$start   = (Get-Date).AddMinutes(5)
$trigger = New-ScheduledTaskTrigger -Once -At $start
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At $start `
    -RepetitionInterval (New-TimeSpan -Minutes 30) `
    -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition

$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 25)

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Local-first deploy-pipeline triage: every 30 min, diagnose any current code-failure in the fleet''s deploy.yml and open a fix PR on the target repo (never auto-ship). Runs on the Claude subscription (no API cost).' | Out-Null

Write-Output "Registered task '$taskName' (every 30 min, next ~$start)."
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State | Format-Table -AutoSize
