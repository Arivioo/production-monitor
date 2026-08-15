# Autonomy Decision Record — Board Drainer

**Status:** APPROVED (Roger, 2026-08-15) · **Rollout:** installed, DRY-RUN (watch-only) · **Owner:** Claude/fleet
**Canonical home for the class decisions.** Code, plan, and runbook implement this; if they ever
disagree, THIS document is the intent of record. Related: `PLAN-BOARD-DRAINER-2026-08-15.md`,
`BOARD-DRAINER-RUNBOOK.md`, `scripts/board-drainer.mjs`.

---

## The decision
Build an autonomous loop that reads the cockpit Monitoring Board (`monitoring_incidents`), and for
every OPEN incident either fixes it (if an autonomous dev session may safely do so) or escalates it to
Roger — draining the board to zero without Roger acting as the message bus between "diagnosed" and
"fixed." Approved with the autonomy boundary below.

## The autonomy boundary (the core class decision)
| The drainer may do ON ITS OWN | It must ALWAYS escalate to Roger |
|---|---|
| Fix monitor/spec/CI/config/pipeline problems, incl. **deploying those to production** (low blast radius, reversible) | **Destructive database** ops (delete/drop/update prod rows, prod migrations) |
| Deploy a **product-code** fix to **STAGING** | Promote **product code to PRODUCTION** |
| **Close** a self-healed / false-red incident — but ONLY with a verified receipt | **Secrets / keys** (rotate/set), **payments**, **emailing customers** |
| | **Business decisions**, ambiguous intent, **low-confidence** diagnoses |
| | Anything needing **Roger's hands** (e.g. Google OAuth reconnect) |

Guiding rule: **when unsure, escalate — never fix on doubt.** Prefer making a detector correct over
asking a human to confirm a false-red.

## The incident classes (what the agent may do per class)
Each open incident is RE-VERIFIED against the live system every run, in one of two modes:

**FIX mode** (owner=Claude, not a hard-escalate class) — full permitted actions:
- **A · INFRA** — monitor/spec/CI/config/pipeline fix. → fix in the owning repo, commit `[board-drainer]`, push, **deploy incl. prod** for these classes, verify green.
- **B · PRODUCT-STAGED** — the app itself is genuinely wrong. → fix + deploy to **staging only**, then **escalate the prod promotion** (never `confirm=deploy` on a product repo).
- **C · CLOSED** — source is GREEN now. → confirm with a real receipt (repro / live check / green run), then close. **Never a shallow close.**
- **D · ESCALATE** — low-confidence, or needs a destructive/secret/payment/business/OAuth action. → do nothing; write a root-cause hypothesis + the exact one-line action for Roger.

**VERIFY mode** (owner=Roger, or a destructive/human-hands class) — READ-ONLY: may ONLY do **C (close-if-green with a receipt)** or **D (escalate)**. It has no write/deploy tools, so it physically cannot fix. This is what auto-closes a self-healed false-red **for any owner** — the exact gap that let the RF incident sit for 27h.

## The escalate gate (how routing is decided — `classify()`)
- **owner** = `who_must_act` starts with "Roger" → VERIFY; starts with "Claude" or unset → FIX (default work to us, never park on Roger).
- **hard-escalate → forced to VERIFY** if the incident text matches:
  - human-hands: oauth/re-auth/reconnect/login/vendor/business-decision/pricing/refund/new-secret/new-credential/rotate/payment/invoice/bank/stripe-dashboard
  - destructive-DB: delete/drop/truncate/purge/destroy/remove-row-record-connection-table/DDL/migration-to-prod

## Guardrails
- **Off by default** — self-skips unless `BOARD_DRAINER_ENABLED=1`; acts only if `BOARD_DRAINER_LIVE=1`.
- **Kill switch** — `BOARD_DRAINER_DISABLED=1` (or Disable-ScheduledTask).
- **Blast radius** — max 3 incidents per run.
- **No infinite bad-fix loop** — after 3 failed attempts on one incident it escalates as "auto-fix stuck".
- **Receipt-guard** — a close verdict without a receipt is refused (downgraded to `investigating`).
- **Reversible + logged** — every action in `C:\Business\_board-drainer\drainer.log`; the agent may only commit/push production-monitor, open PRs on target repos, and deploy the permitted classes.
- **Alarm** — a run that errors emails Roger; the "silently stopped" case is covered by sibling runners on the same box (they alarm if it dies). Dedicated healthchecks dead-man not provisioned (free-plan limit, 2026-08-15).

## Rollout gate (why it's not yet live)
Installed as `Board-Drainer-LocalRunner` (every 20 min) in **DRY-RUN** (classify + log only, no actions).
It flips to LIVE (`set "BOARD_DRAINER_LIVE=1"` in the task) **after** it correctly classifies the first
REAL incident in the dry-run log. The one unsupervised-live risk being guarded: an agent misreading the
policy and prod-deploying product code (`gh workflow run` is in the allowlist; only the policy blocks the
`confirm=deploy` form). One supervised real drain closes that risk.

## Corrections on the record (do not lose)
- **Fix #1 was misdiagnosed.** Initial claim "the Closer re-flags the disconnected connection every run"
  was WRONG: `monitor-sync-health/index.ts:100` sources from `detect_stale_syncs` (`status='connected'`),
  which already excludes disconnected rows. The RF incident's `opened_at` never changed → it was never
  re-opened; it simply SAT unclosed. TRUE root: the Closer is EMAIL-driven, not board-driven, so once the
  email stopped nothing re-visited the open row. The real fix is the drainer's universal verify-and-close
  sweep — no edge-fn change.
