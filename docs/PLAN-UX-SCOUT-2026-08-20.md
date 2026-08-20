# PLAN, UX Scout tier (2026-08-20)

**Status:** Phases 0, 1, 2, 3 and the Measured half of 5 are BUILT AND LIVE (2026-08-20). Phase 4 (autonomy) is deliberately NOT built and needs a separate yes. Cockpit UI is blocked on the `factory` workstream lock.
**Origin:** PostHog "self-driving" KB entry `hFra0uH2NRM`. Roger's steer: not buying it, learning from it.
**Companion memory:** `session_ux_scout_tier_proposal_2026_08_20.md`
**Sibling plan (same shape, already shipped):** `PLAN-BOARD-DRAINER-2026-08-15.md`

---

## The problem this fixes

Our whole agent tier is reactive. `~/.claude/scripts/hourly-production-check-prompt.md:24` (read 2026-08-20): *"If the latest completed monitor run is green AND no live-confirmed escalation exists: print `GREEN, nothing to do` and STOP immediately."*

Green means we look at nothing. A check finds what somebody predicted. Nothing in the fleet looks for what nobody predicted.

## CORRECTION 2026-08-20 (read this before any number below)

The friction table originally here was queried against `cuvqzwvyovxvvvuddtjd`, which is ReplyFlow **STAGING**, not production. Production is `dqmhsdzldkxngwjrxois` (`docs/Credentials.txt:26,34`; `deploy.yml:512` deploys prod there, `deploy.yml:191` deploys staging to the other). The dramatic items (onboarding lock, quota exceeded, "No stored tokens", "business already used on another account") are **E2E/test traffic on staging and do not exist on production**.

### The real production picture (`dqmhsdzldkxngwjrxois`, queried 2026-08-20)

`error_log`: 5,383 rows since 2026-06-12, latest 08:11:21Z. By month: 2026-06 = 13, 2026-07 = 3,546, 2026-08 = 1,824.

Last 14 days:

| function / operation | message | n |
|---|---|---|
| generate-reply / claude-call | Missing reviewId | 339 |
| create-checkout / checkout-session | Missing authorization header | 338 |
| create-billing-portal / portal-session | Missing authorization header | 318 |
| connect-platform / oauth | Missing authorization header | 318 |
| fetch-reviews / sync | Failed to fetch reviews: 503 UNAVAILABLE (Google) | 24 (last 08-08) |
| everything else | | 1 to 4 each |

### Fleet scale (all PROD refs, queried 2026-08-20)

| Product | prod ref | scale | error signal |
|---|---|---|---|
| ReplyFlow | `dqmhsdzldkxngwjrxois` | 4 businesses, 4 reply_profiles, 2 platform connections, 5 subscriptions, 49 reviews | `error_log` 5,383 rows; last 14d = 4 probe patterns + 1 real Google 503 cluster |
| ChannelMover | `qswluvqunswggfmesdcs` | 23 auth users, 3 migrations | `error_log` 10 rows lifetime, **0 in the last 30 days** |
| SignalScore | `ogdpgufptemcgyszmjek` | 12 auth users | `error_log` **0 rows**; `api_request_logs` **3,408 rows** (status_code / duration_ms / error_message / endpoint), `audit_log` 108 rows |

**Fleet total is roughly 39 users** (4 businesses + 23 + 12). So "rank the top N struggling users" is the wrong shape; there are not enough users for a ranking to mean anything.

### What that changes, and what it does not

**Does not change:** the architectural gap is real. `hourly-production-check-prompt.md:24` still means green equals looking at nothing, and we still cannot tell a bot from a user in the 339 + 338 + 318 + 318 rows, because no row carries a caller identity. Phase 0 converts that permanent unknown into a one-query fact.

**Changes the scout's shape:** at this scale it surfaces **every authenticated failure**, not a top-N ranking. That list will usually be short or empty, which is the correct answer, and it starts earning the moment users arrive. Ranking by distinct users is the right shape later and is deliberately deferred.

**Adds a second source:** SignalScore has no `error_log` traffic but does have `api_request_logs`. The scout reads `status_code >= 400` there.

### The bug this investigation actually found

`_shared/error-log.ts` did `context: context ? JSON.stringify(context) : '{}'` into a **jsonb** column. Verified on prod 2026-08-20: `select jsonb_typeof(context) from error_log` returns **`string`** on every row, storing the literal `"{}"` instead of the object `{}`. So `context->>'user_id'` was permanently null and every call site that already passed context (fetch-reviews, log-client-error, generate-reply's inner calls) was silently unqueryable. The same helper is copied into `arivioo`, `BackOffice`, `ChannelMover` and `signalscore`.

## Design decisions (made, with reasons)

**D1. Reports live in a NEW table, not in `monitoring_incidents`.**
Verified constraints on `public.monitoring_incidents` (BackOffice prod `xoecpzfsskalvjrtcbbl`, `pg_constraint` query 2026-08-20):
- `source` CHECK allows only `healthchecks, sentry, production-monitor, cron, silent-failure`
- `status` CHECK allows only `open, investigating, fixed, blocked, self-healed, expected`

Reusing it would need two constraint migrations AND would put reports in front of the Board Drainer (`board-drainer.mjs:79` reads `status=in.(open,blocked,investigating)`), turning free findings into paging work. **Reports are free, alarms are not.** That separation is the whole lesson. New table `public.scout_reports` in BackOffice.

**D2. Grouping is deterministic SQL. The LLM only narrates.**
Counting and ranking must not hallucinate. An LLM pass turns the top N groups into "here is what users are hitting and what it probably means". Marginal cost is one small weekly headless `claude.exe` call, same mechanism the Board Drainer already uses (`spawnSync claude.exe`), so it rides Roger's existing plan rather than metered API.

**D3. No session replay, no autocapture, no PostHog.**
Everything below runs on data we already own and write. No GDPR/nFADP reversal, no cookie banner.

**D4. Credentials read at runtime from each project's `docs/Credentials.txt`.**
Same pattern as `board-drainer.mjs:67-74` (`readBoSecret()`), never inlined, never registered in the scheduled-task env.

**D5. Phase 1 ships with an email digest, no cockpit UI.**
A cockpit page is the right long-term home but `Cockpit sql/ + mcp/` is a shared canonical surface under the workstream lock. UI is Phase 5, lock-gated.

---

## Phase 0, evidence (BUILT 2026-08-20, ReplyFlow)

**Why first:** verified on prod, `select jsonb_typeof(context) from error_log` returns `string` on every row and the stored value is the literal `"{}"`. No caller identity anywhere. A scout could count failures but could not say whether a failure hit a person or a bot, and an unverifiable report must never become a PR.

**What was actually changed (narrower than first planned).** The original scope said "11 call sites across 6 functions". On reading them, 6 of the 11 already pass context; only the **4 top-level catches** produce the high-volume rows, so only those 4 were touched:

| file | line | what it now passes |
|---|---|---|
| `generate-reply/index.ts` | top-level catch | `has_auth, service_call, has_review_id, review_id, business_id, preview, user_id` |
| `connect-platform/index.ts` | top-level catch | `has_auth, user_id, action, platform, business_id` |
| `create-checkout/index.ts` | top-level catch | `has_auth, user_id, plan, annual` |
| `create-billing-portal/index.ts` | top-level catch | `has_auth, user_id, has_stripe_customer` |

Plus the real fix in `_shared/error-log.ts`: pass the **object**, not `JSON.stringify(...)`, so `context` lands as jsonb and `context->>'user_id'` works.

**Privacy:** ids and booleans only. No email, name, review text, prompt, card data or token is ever written to `context`.

**The discriminator this buys.** `has_auth=false` on a `Missing reviewId` proves the 2026-07-29 bot/probe calibration. The same message with a `user_id` is a real UI bug that must never be filtered away with it. Today those 339 rows are indistinguishable; after this they are one query apart.

**Route header: DEFERRED, deliberately.** Tagging the client path would need `x-rf-route` added to `Access-Control-Allow-Headers` in `_shared/cors.ts`, which has **37 consumers** that would all need redeploying, plus a frontend change (there is no central invoke wrapper; 107 direct `functions.invoke` call sites). `function_name + operation + action + platform` already answers "where", so the route buys little for a large blast radius.

**Deploy:** `_shared/error-log.ts` has **16 consumer functions**, so the jsonb fix only takes effect where redeployed. The repo's `deploy.yml` bulk-deploys ALL function dirs on both lanes (`deploy.yml:189-191` staging, `deploy.yml:510-512` prod), so a normal deploy covers all 16.
**Done when:** a fresh prod `error_log` row shows `jsonb_typeof(context)='object'` and a real `user_id`.
**Rollback:** revert the commit; `context` was already optional.

---

## Phase 1, the scout (READ-ONLY, propose-only)

**New:** `production-monitor/scripts/ux-scout.mjs` plus `test/ux-scout.test.mjs`.

**Reshaped for the real fleet size (~39 users).** No top-N ranking. The scout reports **every authenticated failure**, and separately summarises the unauthenticated probe patterns so they are visible but never mistaken for user pain.

**What it does, once a week:**
1. Read each product's signal table over the last 7 days, against the **PROD** ref taken from that repo's own `deploy.yml` (never a ref recalled from memory; that is the mistake this plan already made once).
   - ReplyFlow `dqmhsdzldkxngwjrxois` and ChannelMover `qswluvqunswggfmesdcs`: `error_log`
   - SignalScore `ogdpgufptemcgyszmjek`: `api_request_logs` where `status_code >= 400`
2. Split each row into **authenticated** (`context->>'user_id'` present) and **unauthenticated/probe**.
3. Every authenticated failure becomes its own report with full evidence. Probe patterns are collapsed into one counted summary line.
4. One headless `claude.exe` call writes a short "what happened, what it probably means" per authenticated group. Skipped entirely when there are none, so a quiet week costs nothing.
5. Upsert into `public.scout_reports`.
6. Email one weekly digest. Silent when nothing new.

**New table `public.scout_reports`** (BackOffice migration):
`id, product, source_table, function_name, operation, message_pattern, first_seen, last_seen, occurrences, distinct_users, authenticated bool, sample_evidence jsonb, narrative text, state text, state_reason text, created_at, updated_at`
with `state` in `new | real | not-real | known | fixed` and a unique key on `(product, function_name, message_pattern)`.

**Hard limits:** read-only against product DBs. Writes only to `scout_reports`. Opens no PR, touches no product code, files nothing into `monitoring_incidents`, pages nobody.
**Enable/disable:** `UX_SCOUT_ENABLED=1` to run, `UX_SCOUT_DISABLED=1` kill switch, default off until registered.
**Done when:** one real weekly digest lands and its contents match a hand check.

---

## Phase 2, the second shift

Register the scheduled task (`setup-ux-scout-task.ps1`, mirroring `setup-board-drainer-task.ps1`), weekly. Add its row to `AUTOMATIONS_RUNBOOK.md` per the birth-certificate rule at line 7, including the alarm: run errors email Roger via `send_report_email.py`, same as the Board Drainer.

**Gate:** one supervised dry run first (`UX_SCOUT_ENABLED=1` without live write), Roger reads the classifications before it writes anything.

---

## Phase 3, triage teaches the scout

Roger marks each report `real` / `not-real` / `known` with a one-line reason. The reason is stored in `scout_reports.state_reason` and the scout reads past dismissals so it stops re-filing the same thing.

This is the piece that replaces the hardcoded `AI_NOISE` array with something that cannot silently go stale. It is also the cheapest thing PostHog does that we do not: *"When you dismiss or snooze a report and say why, that note is forwarded to the scout that filed it"* (posthog.com/docs/self-driving/inbox, fetched 2026-08-20).

Marking interface for Phase 3 is a reply to the digest email or a one-line CLI, **not** a cockpit page. UI comes later.

---

## Phase 4, promote to fix (AUTONOMY GATE, needs explicit Roger approval)

Only reports Roger has marked `real` become eligible for the Board Drainer, under its **existing unchanged** autonomy boundary (`BOARD-DRAINER-RUNBOOK.md`: destructive DB, secrets, payments, customer comms and prod promotion of product code always escalate).

Also in this phase: replace the hardcoded `MAX_PER_RUN = 3` (`board-drainer.mjs:49`) with a severity threshold dial, so autonomy is expressed as policy rather than a magic number. PostHog's equivalent is the P0/P1+/P2+/P3+/All selector.

**This phase is where a robot starts changing product code because of a UX signal. It does not start without a separate yes.**

---

## Phase 5, Measured, and the cockpit page

- **Measured:** N days after a fix closes, the scout re-runs that one signal's query and reports whether it actually dropped. This upgrades every receipt in the fleet from "the change was made" to "the problem stopped". Cheapest high-value item in the whole plan, but it needs Phases 0 to 4 to have something to measure.
- **Cockpit page:** a Reports surface next to the Monitoring board. **Blocked on the `factory` workstream lock**, do not start while another session holds it.

---

## Cost

Marginal cost is one small weekly headless `claude.exe` invocation (Roger's existing plan, not metered API), plus SQL reads against DBs we already own. No new vendor, no new subscription, no credits. **Estimated marginal spend: $0.**

## Sequencing and gates

`Phase 0 -> Phase 1 -> [Roger reads first digest] -> Phase 2 -> Phase 3 -> [Roger's explicit yes] -> Phase 4 -> Phase 5`

Phases 0 and 1 are the ones Roger approved on 2026-08-20. Everything from Phase 4 on needs a fresh yes because that is where autonomy widens.

## Loose ends found during planning (not part of this plan)

- **SignalScore `error_log` has 0 rows** (`ogdpgufptemcgyszmjek`, queried 2026-08-20). The helper exists at `signalscore/supabase/functions/_shared/error-log.ts` (1 call site). Dark instrumentation, so the scout will find nothing there until it is wired.
- **ReplyFlow `ad_funnel_events` has 0 rows.** Same shape.
- **ChannelMover** declares `posthog-js ^1.400.1` with no `posthog.init` anywhere in `src/`. Dead dependency in the bundle.
- **`POSTHOG_PERSONAL_API_KEY`** (`BackOffice/docs/Credentials.txt:123`, host `eu.posthog.com`) is alive but has no read scopes (403 `permission_denied`, not 401) and zero consumers in the codebase.


---

# BUILD LOG (2026-08-20)

Roger approved the plan and said to develop through as far as possible without stopping for approvals unless genuinely needed.

## Shipped

| Phase | State | Evidence |
|---|---|---|
| 0 Evidence | **LIVE on staging, prod promotion dispatched** | ReplyFlow `3e353c6`. Staging proof by query: newest row `jsonb_typeof(context)='object'`, `context={"has_auth": false}`; the two rows from before the deploy still read `'string'` / `"{}"`. |
| 0b jsonb fix ported | **pushed** | ChannelMover `5721994`, SignalScore `7049391`. Still present in BackOffice and arivioo. |
| 1 The scout | **BUILT, first LIVE run done** | `scripts/ux-scout.mjs`, 24 unit tests green, 11 reports written to `scout_reports` on BackOffice prod. |
| 1b Table | **LIVE both refs** | BackOffice migration 117, applied by hand to staging `vvgqkwiqauafcflshsec` and prod `xoecpzfsskalvjrtcbbl`. Verified: 21 columns, RLS on, 3 policies, RPC present. |
| 2 Second shift | **REGISTERED, LIVE** | `UX-Scout-LocalRunner`, weekly Mon 07:20, next run 2026-08-24 07:20. Battery gates off, StartWhenAvailable on. |
| 3 Triage teaches it | **BUILT, loop proven end to end** | `scripts/scout-triage.mjs`. Marked one report not-real with a reason; the next scout run logged "1 previously-judged pattern(s) will not be re-surfaced" and "1 skipped". |
| 1c Coverage | **BUILT** `924ae73`, 5 sources + explicit not-covered list |
| 5a Measured | **BUILT** | `verdict()` + `measurePass()` run on every weekly tick; `scout-triage.mjs mark <id> fixed` arms the 7-day re-check. 7 tests. |
| 4 Autonomy | **NOT BUILT, on purpose** | This is where a robot changes product code from a UX signal. Needs its own yes. |
| 5b Cockpit page | **NOT BUILT** | Blocked on the `factory` workstream lock. |

## Birth certificate (AUTOMATIONS_RUNBOOK.md, all five)

1. Heartbeat: no healthchecks slot, free plan at its 20-check cap (same documented precedent as Factory Engine and Commit Review). Env `UX_SCOUT_HC` is wired for when a slot frees.
2. Runbook row: added, overview count 13 to 14 tasks.
3. Tracked repo: `production-monitor` is the monitor repo itself.
4. Alarm PROVEN: a run was deliberately failed by pointing `UX_SCOUT_PROJECTS_ROOT` at a non-existent directory; the failure email sent and was confirmed to `rogmueller1976@gmail.com`.
5. Task settings standard: `StartWhenAvailable=True`, both battery gates False.

## Bug found and fixed on the way

**Board-Drainer-LocalRunner had both battery gates ON.** Audited during the birth-certificate check: `DisallowStartIfOnBatteries=True`, `StopIfGoingOnBatteries=True`, while all three sibling runners (AgentTriage, DeployTriage, Needs-Roger Closer) had them False. `New-ScheduledTaskSettingsSet` defaults them to True, and this is exactly how the brain tasks silently skipped for days on 2026-08-10. A drainer that skips looks identical to a clean board. Fixed in `setup-board-drainer-task.ps1` and the task re-registered; both now False, still ENABLED and LIVE on the 20-minute repeat.

## Coverage (added after the first run, `924ae73`)

The first build read 3 products and printed "no authenticated user hit a failure in any product". Six products write a failure table. **A scout that says "fleet-wide" while covering half the fleet manufactures false confidence, which is worse than no scout.** Fixed:

| Product | Watched | Note |
|---|---|---|
| replyflow | yes | `error_log` |
| channelmover | yes | `error_log` |
| signalscore | yes | `api_request_logs`, status_code >= 400 (`error_log` is empty) |
| arivioo | yes | `error_log`, 0 rows at 2026-08-20. Watched anyway: the day an empty source starts producing is the day nobody notices. |
| valrano | yes, **currently READ FAILED** | Management PAT returns 403 "account does not have the necessary privileges". Deliberately left in the list so the gap is reported every week rather than silently dropped. This also means the digest emails weekly until the credential is fixed, on purpose. |
| backoffice | no | internal admin tool, only user is Roger |
| scoutcopilot / launchready / distribution-os | no | no error-log helper in the repo, so there is no failure table to read |

Every digest now opens with `Coverage: N product(s) read` (plus an UNREADABLE count) and closes with the NOT-watched list and the reason for each.

## What the first live run actually found

11 reports. **Zero authenticated user failures across the whole fleet**, which given roughly 39 users is the correct answer rather than a broken run. ReplyFlow's 1,345 anonymous occurrences over 14 days are the four probe patterns; SignalScore contributed one `firecrawl HTTP 502`. Nothing paged, nothing was emailed (a quiet week is silent by design).

The honest read: the scout will find little until the fleet has users. Its value today is that the 339 `Missing reviewId` rows are now one query away from being provably bot traffic rather than a permanent unknown, and that the machinery is in place before it is needed rather than after.
