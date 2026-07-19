# Auto‑Remediation Runbook

**The fleet's self‑healing system: detect → fix → escalate‑with‑diagnosis.** This documents what
is actually built and running as of **2026‑07‑17**, and how to operate, pause, and reproduce it.

Design rationale lives in [`PLAN-agentic-auto-remediation.md`](./PLAN-agentic-auto-remediation.md).
This file is the **operations** reference.

---

## 1. The pipeline

```
  LIVE-SITE surface        hourly (:37)                      on a monitor failure
  ┌───────────────┐   ┌──────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────────────────┐  ┌───────────────┐
  │  monitor.yml  │──▶│  Playwright  │─▶│  auto-fix   │─▶│  auto-heal  │─▶│  agent-triage         │─▶│  send-alert   │
  │  (detection)  │   │  + canaries  │  │  (patterns) │  │  (redeploy) │  │  (Claude, Tier B)     │  │  (email +     │
  └───────────────┘   └──────────────┘  └─────────────┘  └─────────────┘  └───────────────────────┘  │   diagnosis)  │
                                                                                     ▲                 └───────────────┘
                                                                                     │
  DEPLOY-PIPELINE surface (each repo's deploy.yml)                                   │
  ┌───────────────┐   flaky/infra ─▶ flaky-retry.yml (every 30 min): auto-rerun ONCE │
  │  deploy fails │──▶│                                                              │
  └───────────────┘   code fail ──▶ deploy-failure-triage.mjs (every 30 min):  ──────┘
                         Claude Tier B → opens a FIX PR on the target repo (never auto-ship)

  BOTH AI tiers run LOCAL-FIRST on Roger's subscription = $0 API:
    · agent-triage        ← local-triage-runner.mjs   (Windows task AgentTriage-LocalRunner, 20m)
    · deploy-failure-triage ← deploy-failure-triage.mjs (Windows task DeployTriage-LocalRunner, 30m)
  cloud/API paths are the DORMANT FALLBACK (for when the desktop is off)
```

**Two surfaces: the live SITE (monitor.yml → agent-triage) and the deploy PIPELINE (deploy.yml →
flaky-retry for infra, deploy-failure-triage for code). Detection is cloud (cheap); the expensive AI
triage runs on the local subscription by default.**

---

## 2. Components

### Pre‑existing (detection + fast remediation)
| File | What it does | Guardrails |
|---|---|---|
| `.github/workflows/monitor.yml` | Hourly Playwright specs per project + live‑credential canaries + healthchecks.io dead‑man's‑switch | 25‑min timeout; concurrency cancel‑in‑progress |
| `scripts/auto-fix.mjs` | Pattern fixes to **test files only** (CSP console noise, flaky‑timeout doubling) | Max 5/run; never edits app source; escalate after 3 consecutive |
| `scripts/auto-heal.mjs` | Redeploys a project on **site‑down** signals (blank/MIME/5xx/`net::ERR`) | 2 consecutive fails; max 1 redeploy/project/6h |
| `scripts/send-alert.mjs` / `send-resolved.mjs` | Failure + resolution emails (now includes the triage verdict) | — |
| `.github/workflows/drift-check.yml` | Nightly staging/prod schema + pipeline‑conformance drift | — |

### Phase 1a — deploy‑status dashboard consistency (in BackOffice repo)
- `supabase/functions/deploy-status/index.ts`: `overall` now goes **red whenever the latest run
  failed**, not only on an environment failure — fixes the "gate‑e2e failed but summary says
  *Nichts zu tun*" contradiction. Deployed (Supabase `xoecpzfsskalvjrtcbbl`) + committed (`9ee2b85`).

### Phase 1b — flaky‑deploy auto‑retry
| File | What it does |
|---|---|
| `scripts/flaky-retry.mjs` | Cross‑fleet poll: reruns a flaky/infra deploy failure **once** |
| `.github/workflows/flaky-retry.yml` | Schedule every 30 min (`DASHBOARD_PAT`) |

**Safety:** never a prod promotion (`workflow_dispatch`), never a stale commit (HEAD guard),
never a code failure (lint/build/unit → skipped), 1 retry max (`run_attempt` gate), 3h window.
**Kill‑switch:** repo variable `FLAKY_RETRY_DISABLED=1`. **Dry run:** dispatch with `dry_run=true`.

### Phase 2 — agent‑triage (the AI tier)
On a failure the patterns + auto‑heal can't resolve, a headless **Claude Code** agent diagnoses
each and remediates within **Tier B** policy. Runs **local‑first** (subscription) with a cloud
API **fallback**.

| File | Role |
|---|---|
| `scripts/agent-triage.mjs` | The agent orchestrator (both local + cloud modes). Reads the escalations, invokes `claude`, folds the verdict into the alert. |
| `scripts/local-triage-runner.mjs` | **LOCAL‑FIRST** poller: checks the latest monitor run; on failure, triages locally from a pristine isolated clone on the subscription. |
| `scripts/setup-local-triage-task.ps1` | Registers the Windows Scheduled Task that runs the poller every 20 min. |
| `.github/workflows/agent-triage-test.yml` | Manual dry‑run smoke test (cloud). |
| `monitor.yml` step "Agent triage" | The cloud/API **fallback** path (dormant; `AGENT_TRIAGE_ENABLED=0`). |

**Tier‑B policy (what the agent may do):**
| Class | Action |
|---|---|
| Monitor‑drift (product intentionally renamed a label/route the spec asserts on, proven by a target‑repo commit) | Edit the spec + commit/push to **this** repo (safe self‑heal) |
| Real regression | Open a **PR** on the target repo with a diagnosis — **never** auto‑ships app code |
| Flaky / site‑down | None — handled by retry / auto‑heal |
| Secret / config | Escalate with which credential + how to rotate |
| Unknown | Escalate with a written root‑cause hypothesis |
**Hard rule:** never rewrite a spec to make a failing test green if the product is actually broken
(never mask a regression). Destructive `gh` (merge/cancel/delete/dispatch) is not in the allow‑list.

### Phase 2b — deploy‑failure‑triage (AI tier for the DEPLOY PIPELINE)
`agent-triage` reacts to **live‑site** monitor failures. Its sibling reacts to **deploy‑pipeline**
failures: when a repo's `deploy.yml` goes red on a **code** step (build / typecheck / lint / unit /
`gate-e2e`) that `flaky-retry` deliberately won't retry, a headless Claude agent diagnoses the root
cause and opens a **fix PR** on the target repo. It **never auto‑ships** — no push to the deploy
branch, no merge, no prod dispatch.

| File | Role |
|---|---|
| `scripts/deploy-failure-triage.mjs` | Orchestrator: polls the fleet's `deploy.yml`, finds the current code‑failure per repo, clones it pristine, invokes `claude` (Tier B), records verdicts. Also a `DEPLOY_TRIAGE_DETECT_ONLY=1` probe (poll + classify, no clone/agent/writes). |
| `scripts/setup-deploy-triage-task.ps1` | Registers the `DeployTriage-LocalRunner` Windows task (every 30 min, subscription). |

**Only acts when it can't collide with anything:** LATEST run per branch only, and only if its
`head_sha` still equals branch HEAD (a newer commit or a newer green run → **skip**, so it never
touches a superseded/already‑fixed commit or an actively‑pushed branch); `push`/`schedule` events
only (never a `workflow_dispatch` prod promotion); **code** failures only (infra stays with
flaky‑retry / auto‑heal); one PR per broken commit (dedup by `repo@head_sha` in
`deploy-triage-state.json`, plus an open‑PR check).

**Tier‑B policy (deploy):**
| Class | Action |
|---|---|
| Regression / real code break | Smallest correct fix on an `agent/deploy-fix-*` branch → **PR** against the deploy branch (verified locally if quick) |
| Test‑drift (product changed, test asserts old behaviour, proven by a commit) | Fix the **test** in a PR — never weaken/delete a test to force green |
| Env / secret / CI‑config | Escalate with exactly which secret/config + the fix |
| Cannot safely patch | Escalate with root cause + a suggested patch in prose (no low‑confidence PR) |
**Gate:** runs when `DEPLOY_TRIAGE_ENABLED=1` AND (`DEPLOY_TRIAGE_LOCAL=1` subscription OR API key).
**Kill‑switch:** machine env `DEPLOY_TRIAGE_DISABLED=1`. **Dry run:** `DEPLOY_TRIAGE_DRY_RUN=1`.
**Alerts (2026‑07‑19):** on a fix‑PR or an escalation it **emails `ALERT_EMAIL`** (reads
`SMTP_*`+`ALERT_EMAIL` from the USER env — set on the desktop, out of git). Falls back to the log if
unset. Probe: `DEPLOY_TRIAGE_TEST_EMAIL=1 node scripts/deploy-failure-triage.mjs`.
**Same hard rules as agent‑triage** (no destructive `gh`, target‑repo changes are PRs only, never
mask a real break).

---

## 3. Local‑first execution (the default, $0 API)

- **Local CLI:** `C:\Users\roger_rwjnmnz\.local\bin\claude.exe`, authed via Roger's **subscription**
  (no `ANTHROPIC_API_KEY` in env) → runs on the flat plan, **no metered API cost**.
- **Scheduled tasks (both Interactive logon, inherit subscription + `gh` auth):**
  - `AgentTriage-LocalRunner`, every 20 min → `node scripts/local-triage-runner.mjs` (live‑site monitor).
  - `DeployTriage-LocalRunner`, every 30 min → `scripts/deploy-failure-triage.mjs` (deploy pipelines).
- **Isolated workdirs** under `C:\Business\_agent-triage\`:
  - `production-monitor\` — pristine clone reset to `origin/master` each run (monitor triage).
  - `deploy-fixes\<repo>\` — one pristine clone per target repo, reset to the failed HEAD (deploy triage).
- **State:** `state.json` (monitor: last handled run id) · `deploy-triage-state.json` (deploy: dedup by `repo@head_sha`).
- **Logs:** `runner.log` (monitor) · `deploy-triage.log` (deploy).

**Requires the desktop on AND logged in.** Fully logged off → the task pauses; use the cloud
fallback if Roger will be away.

### Cloud fallback (desktop off)
- Dedicated Anthropic workspace **"Production Monitor"** (`wrkspc_01CYEvSMyEX8tNpq8M6JqiSm`) in the
  **Predivo GmbH** org, **$25/mo spend cap**.
- Key stored as GitHub secret `AGENT_TRIAGE_API_KEY` on `Arivioo/production-monitor`.
- **Activate:** set repo variable `AGENT_TRIAGE_ENABLED=1`. The monitor.yml step then runs the agent
  in the cloud on the paid key (~$1–2/incident, capped $25/mo). **Deactivate:** set it back to `0`.

---

## 4. Cost model

| Path | When | Cost |
|---|---|---|
| Local (subscription) | Desktop on + logged in (default) | **$0 API** (flat plan; ~$1–2 API‑equivalent/incident absorbed) |
| Cloud (API key) | `AGENT_TRIAGE_ENABLED=1` (desktop off) | ~$1–2/incident, hard **$25/mo** cap |
| Detection / flaky‑retry | Always | GitHub Actions minutes only (no API) |

Triage fires **only on real failures the fast patterns can't handle** — rare, since the fleet is
usually green.

---

## 5. Operations

### Check status
```bash
# Is the fleet green?  Latest monitor run:
gh run list --repo Arivioo/production-monitor --workflow=monitor.yml --limit 3
# What did the local runner do lately?
Get-Content C:\Business\_agent-triage\runner.log -Tail 20        # PowerShell
# Is the task healthy?
Get-ScheduledTaskInfo -TaskName AgentTriage-LocalRunner          # LastTaskResult 0 = ok
# Did the agent commit/PR anything?
gh api repos/Arivioo/production-monitor/commits --jq '.[].commit.message' | grep agent-triage
# Dashboard:
# https://backoffice.predivo.ch/deploy-status
```

### Kill‑switches (each is independent)
```powershell
# Stop the local AI triage entirely:
Unregister-ScheduledTask -TaskName AgentTriage-LocalRunner -Confirm:$false   # or Disable-ScheduledTask
# Stop the flaky-deploy auto-retry:
gh variable set FLAKY_RETRY_DISABLED --repo Arivioo/production-monitor --body 1
# Ensure the cloud/API triage stays off:
gh variable set AGENT_TRIAGE_ENABLED --repo Arivioo/production-monitor --body 0
```
Everything else (detection, canaries, auto‑fix, auto‑heal, alerts) keeps running.

### Manually re‑triage a specific run (local, subscription)
```powershell
cd "C:\Business\Internal Projects\production-monitor"
$env:LOCAL_TRIAGE_FORCE_RUN='<runId>'; $env:LOCAL_TRIAGE_DRY_RUN='1'   # drop DRY for real
node scripts/local-triage-runner.mjs
```

### Smoke‑test the cloud agent (paid, one small run)
```bash
gh workflow run agent-triage-test.yml --repo Arivioo/production-monitor   # needs the key + ENABLED=1
```

---

## 6. Reproduce the setup (if the machine is rebuilt)
1. Ensure `claude` CLI installed + logged in to the subscription; `gh` authenticated; `node`, `git` present.
2. Register the task: `& "C:\Business\Internal Projects\production-monitor\scripts\setup-local-triage-task.ps1"`.
3. (Cloud fallback) Recreate a capped Anthropic workspace + key → set secret `AGENT_TRIAGE_API_KEY`.
   Keep repo var `AGENT_TRIAGE_ENABLED=0` unless the desktop is off.

---

## 7. Config reference
| Name | Where | Meaning |
|---|---|---|
| `AGENT_TRIAGE_ENABLED` | repo **variable** | `1` = cloud/API triage armed; `0` = off (current — local is primary) |
| `AGENT_TRIAGE_API_KEY` | repo **secret** | Cloud fallback key (dedicated `$25/mo` workspace) |
| `AGENT_TRIAGE_LOCAL` | env (set by runner) | `1` = run on local subscription CLI, no API key |
| `AGENT_TRIAGE_DRY_RUN` | env | `1` = investigate read‑only, write only the verdict |
| `FLAKY_RETRY_DISABLED` | repo variable | `1` = pause flaky‑deploy auto‑retry |
| `LOCAL_TRIAGE_FORCE_RUN` | env | Force the runner to triage a specific run id |
| `DASHBOARD_PAT` | repo secret | Fleet‑wide PAT (cross‑repo read + `actions:write`) |

---

## 8. Known residuals (watch these)
- **Live write path unexercised.** Every real case tested was an *already‑healed* drift, so the agent
  correctly no‑op'd. The first genuine **new** drift will be the first live spec‑fix commit — watch
  `runner.log` + new `[agent-triage]` commits/PRs on production‑monitor. Kill‑switch ready.
- **Task needs an active logon** (§3). Desktop on but logged off → local triage pauses.
- **6 static repos** still carry an old FTP‑retry `set +e` bug (separate deploy‑pipeline backlog).
