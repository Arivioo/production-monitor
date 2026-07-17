# PLAN — Agentic Auto‑Remediation for the Production Monitor

**Goal:** a closed‑loop, self‑healing fleet. The monitor must not just *detect* and *alert* — it must auto‑*remediate* every failure it can safely resolve, and escalate to Roger only genuine unknowns, each with a written diagnosis. **Hard constraint: never silently mask a real regression.**

> **STATUS (2026‑07‑17):** Autonomy **Tier B** chosen. **Phase 1a** (deploy‑status dashboard consistency) shipped. **Phase 1b** (flaky‑deploy auto‑retry) live on a 30‑min schedule. **Phase 2** (agent‑triage tier) built + wired + **dormant behind the PAID‑KEY GATE** — activate by setting repo variable `AGENT_TRIAGE_ENABLED=1` and secret `AGENT_TRIAGE_API_KEY` on Arivioo/production‑monitor. Phase 3 (drift prevention at source) not yet started.

---

## 1. What already exists (grounded — do NOT rebuild)

- **Detect** — `monitor.yml` (hourly): Playwright specs per project + live‑credential **canaries** + a **healthchecks.io dead‑man's‑switch** (catches the monitor itself going silent).
- **`auto-fix.mjs`** — pattern‑based, **test‑side‑only** fixes: CSP console‑noise filters, flaky‑timeout doubling. Guardrails: max 5/run, never edits app source, loop‑escalate at 3 consecutive auto‑fixes.
- **`auto-heal.mjs`** — redeploys a project on **site‑down** signals (blank / MIME / 5xx / `net::ERR`). Guardrails: only after 2 consecutive failures, max 1 redeploy / project / 6h.
- **`send-alert.mjs`** + resolution email (the alert you received).
- **`drift-check`** — *in active development*: pipeline‑drift rules (FTP `set +e`, lockfile integrity, …) via `DASHBOARD_PAT`.
- **BackOffice** — `deploy-status` dashboard (read‑only + manual dispatch/rerun) and `sync-remediate` (API‑sync auto‑heal, hourly, no‑op when healthy).

## 2. The gaps (why a failure "just sits there")

1. **Novel failures fall through.** `auto-fix` only knows CSP + timeouts. Anything else — a renamed label, a changed selector, a new error type — has no pattern → bare escalation email. *(Exactly what just happened: my "Needs Reply → New & Drafts" rename.)*
2. **No diagnosis.** An escalation says "test X failed," not *why*, and not *flaky vs. real bug*.
3. **Deploy‑pipeline failures aren't remediated.** A flaky `gate-e2e` (e.g. the referral‑matrix auth timeout caused by two concurrent prod‑promotions) isn't auto‑retried; the deploy‑status dashboard is view‑only.
4. **Drift isn't prevented at source.** A project renaming a label doesn't flag the monitor spec that asserts on it.
5. **Dashboard inaccuracies** (my earlier incomplete fix): a failed run whose deploy job was *skipped* shows a red card while the summary says green; flaky timeouts get mislabeled "Code fix needed."

## 3. Proposed: an AI‑agent triage tier

Insert one step into the on‑failure path:

```
monitor fails → auto-fix (fast patterns) → [NEW] agent-triage → auto-heal → alert (now carries the diagnosis)
```

`agent-triage` spawns a headless Claude agent with: the failing tests + errors + Playwright screenshots/traces, the live site, and the **target project's** recent commits + relevant source. It classifies each failure and acts:

| Class | Signal | Action |
|---|---|---|
| Flaky / transient | timeout, network blip, concurrent‑run contention | bounded re‑run |
| Site broken | blank / MIME / 5xx | hand to `auto-heal` (redeploy) |
| **Monitor drift** (intended UI change) | failing assertion matches a label/route renamed in a recent project commit | **update the monitor spec + commit** |
| **Real regression** | app genuinely broke; no matching intended change | **open a fix PR** with diagnosis — never silent |
| Secret / config | canary fail, auth rate‑limit | re‑set/rotate where safe, else escalate |
| Unknown | none of the above | escalate **with a written root‑cause hypothesis** |

Output: a structured verdict per failure, folded into the alert email — you get *diagnosis + what it did*, not a red row.

## 4. Guardrails

- Bounded re‑runs; loop detection (same failure 3× → stop + escalate).
- **Never auto‑touch app source silently** — real‑regression fixes are always PRs.
- Cost ceiling: triage fires only on real failures (healthy runs ≈ free, like `sync-remediate`); token cap per run.
- Full audit log + email of every action; a kill‑switch flag to disable autonomy instantly.

## 5. Autonomy — Roger's call (shapes the whole build)

- **Tier A (conservative):** agent diagnoses + proposes; zero write actions without approval (everything is a PR/draft).
- **Tier B (balanced — recommended):** agent auto‑executes the *safe* classes end‑to‑end (monitor‑drift spec fixes, flaky re‑runs, redeploys) but only *opens PRs* for app‑code regressions — never auto‑ships app code.
- **Tier C (aggressive):** auto‑fix + auto‑deploy everything within policy; escalate only the unresolvable.

## 6. Phasing

- **Phase 1 (days, low‑risk):** flaky‑`gate-e2e` auto‑retry; a concurrency guard so two prod‑promotions can't run E2E simultaneously (root of the referral‑matrix timeout); finish deploy‑status summary/card consistency + flaky‑vs‑code classification.
- **Phase 2:** the agent‑triage tier at the chosen autonomy tier.
- **Phase 3:** drift prevention at source — extend `drift-check` so a project PR that renames a label/route/`data-testid` flags the monitor spec referencing it, catching drift in the project's own CI before it reaches prod.

## 7. Open decisions

1. Autonomy tier (rec: **B**).
2. Scope: pilot on ReplyFlow first, or roll out fleet‑wide.
3. Cost ceiling for the agent tier.
4. Agent model (Opus = best diagnosis; Sonnet/Haiku = cheaper per run).
