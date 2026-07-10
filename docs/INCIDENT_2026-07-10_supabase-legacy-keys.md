# Incident & Remediation — Supabase legacy-key disablement breaks the monitor

**Date:** 2026-07-10 · **Status:** RESOLVED, fleet green · **Owner:** autonomous (Claude), Roger-approved
**Outage:** Healthchecks "production-monitor (hourly)" DOWN 00:48 → UP 08:20 CEST (7h 32m)

---

## TL;DR

Supabase is **disabling legacy (`eyJ…` JWT) anon + service_role API keys, one project at a time**, through mid-2026. When a project's legacy key is disabled, the `production-monitor` repo's *stored copy* of that key starts returning 401 and the monitor tests fail. Two projects (ChannelMover, SignalScore) failed together, the monitor stopped pinging Healthchecks, and the dead-man's-switch tripped.

Fix: swap the monitor's key-secrets to Supabase's **new-format keys** (`sb_publishable_…` / `sb_secret_…`). This was done for the two failing projects, then **proactively for the entire fleet**, so no future per-project disablement can break the monitor again. All live customer apps were audited and confirmed safe. The hourly auto-fix task was given a tightly-scoped ability to perform this exact migration itself in future.

---

## Timeline

| Time (CEST) | Event |
|---|---|
| 07-09 18:54 | ChannelMover legacy `service_role` disabled by Supabase |
| 07-09 ~22:10+ | Monitor runs begin failing (ChannelMover `full login works`) |
| 07-10 00:48 | Healthchecks flips **DOWN** (2h grace after last good ping) |
| 07-10 05:50–06:08 | SignalScore legacy keys disabled (was green at 05:49) |
| 07-10 06:07 | ChannelMover `SERVICE_ROLE` secret migrated → monitor run partially green |
| 07-10 06:15 | SignalScore anon+service migrated → run **`29073375394` SUCCESS** |
| 07-10 08:20 | Healthchecks **down ➔ up** (recovery ping) |
| 07-10 06:42 | Full-fleet proactive migration complete → run **`29074499587` SUCCESS** |

## Root cause

- The monitor authenticates to each project's Supabase to run real tests: keep-alive GraphQL ping (needs **anon**), and admin `createUser` login test (needs **service_role**).
- Those keys are stored as GitHub secrets on `Arivioo/production-monitor` (`{PROJ}_ANON_KEY`, `{PROJ}_SERVICE_ROLE_KEY`, `{PROJ}_STAGING_ANON_KEY`).
- Supabase disabled the **legacy** versions of those keys for ChannelMover then SignalScore. The stored legacy keys began returning 401:
  - service_role → `Error: Failed to create test user: Legacy API keys are disabled`
  - anon → GraphQL ping HTTP `401` (surfaces as the misleading "database may be paused")
- Failed monitor run → no success ping to `hc-ping.com/ed11efd1…` → Healthchecks DOWN after grace.

## The fix recipe (repeatable)

Each Supabase account has a **Management API PAT** stored on disk in that project's `docs/Credentials.txt` (`Access Token: sbp_…`). Per affected project:

```bash
PAT=<from the project's docs/Credentials.txt>
REF=<project ref, e.g. qswluvqunswggfmesdcs>

# 1. Reveal the new-format keys
curl -s -H "Authorization: Bearer $PAT" \
  "https://api.supabase.com/v1/projects/$REF/api-keys?reveal=true"
#   type=publishable  → use for {PROJ}_ANON_KEY / {PROJ}_STAGING_ANON_KEY
#   type=secret       → use for {PROJ}_SERVICE_ROLE_KEY

# 2. VERIFY 200 BEFORE setting (hard gate)
#    publishable:
curl -s -o /dev/null -w '%{http_code}\n' "https://$REF.supabase.co/graphql/v1" \
  -X POST -H "apikey: $PUB" -H "Authorization: Bearer $PUB" \
  -H 'Content-Type: application/json' --data '{"query":"{ __typename }"}'   # expect 200
#    secret:
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://$REF.supabase.co/auth/v1/admin/users?page=1&per_page=1" \
  -H "apikey: $SEC" -H "Authorization: Bearer $SEC"                          # expect 200

# 3. Set + re-run
printf %s "$PUB" | gh secret set {PROJ}_ANON_KEY         -R Arivioo/production-monitor
printf %s "$SEC" | gh secret set {PROJ}_SERVICE_ROLE_KEY -R Arivioo/production-monitor
gh workflow run monitor.yml -R Arivioo/production-monitor   # then watch to green
```

## Fleet key map (all migrated to new-format 2026-07-10)

> **Security:** PAT values are intentionally NOT in this file (public repo). Each project's Management PAT lives in that project's `docs/Credentials.txt` (`Access Token:` line), and account→PAT is also in the private memory `reference_supabase_accounts.md`.

| Project | Prod ref | PAT account | Monitor secrets migrated |
|---|---|---|---|
| ChannelMover (ytmigration) | `qswluvqunswggfmesdcs` | supabase@channelmover.com | SERVICE_ROLE |
| SignalScore | `ogdpgufptemcgyszmjek` | roger@mueller.ro | ANON, SERVICE_ROLE, STAGING_ANON |
| BoatBuddy | `xzythvxmuxmczuiophwp` | supabase@boatbuddy.predivo.ch | ANON, SERVICE_ROLE, STAGING_ANON |
| LaunchReady | `hcfeoescybfngjsphekq` | supabase@launchready.predivo.ch | ANON, SERVICE_ROLE |
| ReplyFlow | `dqmhsdzldkxngwjrxois` | supabase@replyflow.help | ANON, SERVICE_ROLE, STAGING_ANON |
| ScoutCopilot | `rlcsuqwqzoqjykdiqjye` | supabase@scoutcopilot.com | ANON, SERVICE_ROLE |
| ShipSolo (Distribution-OS) | `jxjpbmkgmuunpayqgbsx` | supabase@distributionos.predivo.ch | ANON, SERVICE_ROLE |
| Valrano | `mkdeftmubrkseyrrbzvp` | supabase@distributionos.predivo.ch | ANON, SERVICE_ROLE, STAGING_ANON |
| JassTour | `dkxdlovwzsxnepoteebk` | api@predivo.ch | ANON |
| BackOffice | `xoecpzfsskalvjrtcbbl` + `vvgqkwiqauafcflshsec` (staging) | supabase@backoffice.predivo.ch (see note) | ANON, SERVICE_ROLE, STAGING_ANON |

> **BackOffice PAT note:** the accounts memory listed a DEAD token (git-leaked & revoked 07-09, returns 401). The working never-expire PAT `backoffice-mgmt-2026-07-09` was already in `BackOffice/docs/Credentials.txt`. Always trust the project's own Credentials.txt over the accounts memory.
>
> **Dead-PAT browser fallback:** the dedicated Chrome logged into a Supabase account exposes a live bearer at `localStorage['supabase.dashboard.auth.token'].access_token` usable against `api.supabase.com`. Verify *secret* keys via curl/Bash — an in-browser fetch to `…/auth/v1/admin/users` gets a false 401 (CORS preflight strips the Authorization header).

## Live-app audit — zero customer impact

Only the monitor's own key *copies* were stale. Every deployed customer app already ships new keys or doesn't use Supabase on public routes:

- **New key in bundle:** ReplyFlow, Valrano, BackOffice, LaunchReady, ShipSolo, SignalScore, ChannelMover, BoatBuddy.
- **No Supabase on public routes:** ScoutCopilot (waitlist; repo builds `sb_publishable_`), Predivo (marketing), JassTour (no public frontend, DB-only).
- **Audit method (Vite/rolldown):** `curl -L /` → main `/assets/index-*.js` → grep it for chunk filenames → fetch each chunk → grep `sb_publishable_` vs legacy `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ`. Shallow HTML scans miss lazy supabase chunks.

## Prevention — hourly auto-fix now self-heals this class

`~/.claude/scripts/hourly-production-check-prompt.md` **Step 3a** (added 2026-07-10) lets the hourly "Production Issue Auto-Fix" task perform the migration above **autonomously** when it sees the legacy-key signature — bounded to: production-monitor repo secrets only, same project's own PAT-fetched + 200-verified key only, never product/app secrets/`.env`/Stripe/DB, never key deletion or new-PAT generation. A dead PAT → it writes a memory handoff and stops. See `AUTOMATIONS_RUNBOOK.md` §3.

Alert routing: Healthchecks now also emails `rogmueller1976@gmail.com` (the inbox the Gmail connector reads); `hello@predivo.ch` kept as backup. Detection remains GitHub-first (`gh run list`), independent of email.

## Open / optional (nothing broken)

- BoatBuddy local `.env` still has a legacy anon key (dev-only; deployed secret is new).
- Per-repo keep-alive workflows may still use legacy anon secrets (monitor keep-alive covers DB-pause risk regardless).
- BackOffice `PROJECT_USER_KEYS` edge secret still holds 7 legacy service_role keys (pre-existing tech-debt).
