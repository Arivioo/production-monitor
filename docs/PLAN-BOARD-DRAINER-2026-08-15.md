# PLAN — Board Drainer: autonomous incident EXECUTE-loop (2026-08-15)

Roger-approved 2026-08-15. Closes the one structural gap that forced Roger to be the
message bus between "diagnosed" and "fixed."

## Root problem
The fleet's detect -> diagnose -> prescribe pipeline is strong; the EXECUTE step depends on a
human. Evidence (mapped 2026-08-15):
- production-monitor's autonomous stack (auto-fix.mjs, agent-triage.mjs + AgentTriage-LocalRunner
  every 20min, deploy-failure-triage.mjs + DeployTriage-LocalRunner every 30min, auto-heal.mjs,
  flaky-retry.yml) is LIVE and healthy, BUT each only sees its own narrow GitHub-Actions slice
  (one monitor.yml run, or one deploy.yml HEAD). None reads `monitoring_incidents`.
- The board `monitoring_incidents` (BO Supabase xoecpzfsskalvjrtcbbl) aggregates ALL sources
  (healthchecks|sentry|cron|silent-failure|production-monitor) and already encodes owner via
  `who_must_act` ("Roger - ..." vs "Claude - ..."). Its ONLY writer is the hourly Needs-Roger
  Closer (works from Gmail); its ONLY reader is the read-only monitoring-board edge fn (cockpit UI).
- GAP: nothing polls the board for open+owner=Claude items, dispatches a bounded autonomous dev
  session against them, and writes the result back. Every primitive to do this already exists.

## Design — ONE new local runner, reusing existing primitives
`Board-Drainer-LocalRunner` (Windows Scheduled Task, ~every 20min, interactive logon like
AgentTriage-LocalRunner so it inherits Roger's Claude subscription + gh auth). Reuses
agent-triage.mjs's headless-claude execFileSync pattern, Tier-B policy, allowedTools allowlist,
dedup-state file, local-first execution, kill-switch convention, and the board's upsert_incident writer.

Loop each run:
1. READ board via BO PostgREST: `monitoring_incidents` where status in (open,blocked,investigating).
   (sb_secret key needs a NON-browser User-Agent, e.g. node-fetch/1.0 - browser UA is 403'd.)
2. PARTITION each incident:
   - owner=Roger OR class in {destructive-DB/DDL, secret/key, payment, external-customer-comms,
     business-decision, OAuth/Roger-hands} -> ESCALATE ONLY. Ensure who_must_act="Roger - <one-line>";
     leave for the Closer's inbox enforcement. The drainer NEVER performs these.
   - owner=Claude / unowned -> dispatch a bounded headless claude dev session.
3. DEV SESSION diagnoses + fixes within the boundary:
   - monitor spec / CI / pipeline / config / stale-threshold fix -> fix + deploy (low blast radius)
     autonomously, incl. prod for these classes.
   - product-code behavior fix -> fix + deploy to STAGING autonomously, then ESCALATE the prod
     promotion (upsert who_must_act="Roger - promote prod: <exact cmd>", status=blocked). NEVER
     auto-promote product code to prod.
   - low-confidence / ambiguous root cause -> ESCALATE with a written root-cause hypothesis; do NOT guess-fix.
4. WRITE BACK via upsert_incident:
   - Close (status=fixed/self-healed) ONLY with a VERIFIED-GREEN receipt (reproduction / live check /
     observed green run) - never a shallow "looks fine" (the 2026-08-14 mistake: closed a symptom,
     Closer re-opened it). Otherwise leave open with a progress note.

## Autonomy boundary (Roger-approved 2026-08-15)
- AUTONOMOUS: monitor/spec/CI/config/pipeline fixes incl. prod deploy of THOSE classes; closing
  false-reds/self-healed with a verified receipt; STAGING deploy of product-code fixes.
- ESCALATE ALWAYS (hard-blocked, never in allowedTools): destructive DB/DDL, secrets/keys rotation,
  payments, external customer comms, PROD promotion of product code, business decisions,
  low-confidence diagnoses, anything needing Roger's hands (e.g. Google OAuth).

## Companion root fix — CORRECTED 2026-08-15 (verified against the code)
Original hypothesis (edit RF `monitor-sync-health` to ignore disconnected connections) was WRONG:
`monitor-sync-health/index.ts:100` sources stale connections from `detect_stale_syncs`, whose SQL
already has `where c.status='connected'` - so a disconnected connection is ALREADY excluded and the
edge fn never re-flagged it. Verified the RF incident's `opened_at` never changed (never re-opened);
it simply SAT blocked. TRUE root: the Needs-Roger Closer is driven by alert EMAILS, not by the board,
so once `monitor-sync-health` stopped emailing (post-disconnect) NOTHING re-visited the open row to
close it. No component sweeps all open board rows and re-verifies them.
FIX #1 (real): the Board Drainer re-verifies EVERY open incident each run. Claude-owned fixable -> FIX
mode; everything else (owner=Roger / destructive / human-hands) -> VERIFY mode (read-only: close-if-green
with a receipt, else leave escalated). This auto-closes a self-healed false-red for ANY owner - the exact
class that bit us - with no edge-fn change needed.

## Guardrails / birth-certificate gate
- Global kill switch: env `BOARD_DRAINER_DISABLED=1` -> skip loudly.
- Per-run cap: max 3 incidents worked/run (blast radius).
- Dedup state file: same incident key attempted >N times -> stop auto-attempting, escalate as
  "auto-fix stuck, needs Roger" (never infinite-loop a bad fix).
- Every action logged (what/why/receipt) + reversible.
- Its OWN healthchecks heartbeat (success/fail ping) + a runbook row + a monitor alarm, so a
  silently-broken drainer is itself alarmed (a broken autofixer is worse than none).
- allowedTools allowlist EXCLUDES any destructive DB / secret / payment / prod-product-deploy verb.

## Build stages (each verifiable + reversible; nothing auto-acts until Stage 6)
1. Reader+classifier, DRY-RUN: read live board, print per-incident {owner, class, decision fix|escalate,
   confidence}. Touches nothing. Validate against real + synthetic rows.
2. Write-back path: upsert_incident close/re-key, tested on a SYNTHETIC incident only.
3. Executor: wire the bounded headless-claude dev session (start read+PR-only, then enable the agreed
   autonomous classes).
4. Guardrails + birth-cert: heartbeat, runbook row, kill switch, alarm, dedup/cap.
5. Fix #1 shipped + verified (RF monitor-sync-health + Closer ignore disconnected).
6. Register the scheduled task; supervise the first live drains before trusting it unattended.
