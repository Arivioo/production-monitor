import { test, expect } from '@playwright/test';

/**
 * Nightly-gauntlet health.
 *
 * For each tiered (Supabase-staged) product, verify the most recent SCHEDULED run of
 * deploy.yml — the nightly gate-critical / gate-integration / gate-e2e gauntlet against
 * LIVE STAGING (deploy-standard.md §4b) — did not fail.
 *
 * WHY HERE (consolidation, not a parallel system): this is the ALERT path for the nightly
 * gauntlet. It runs inside the hourly production-monitor, so a failed nightly rides the
 * SAME notification chain as every other monitor check — send-alert.mjs email to Roger,
 * auto-resolve ("all clear") email, and the healthchecks.io dead-man's-switch. No per-repo
 * "send alert on failure" steps, no second alerting system. The Deploy-Status page already
 * VIEWS each repo's latest run; this adds the missing PUSH alert through the one engine that
 * already owns alerting. (Health Monitor = on-demand LIVE-PROD health view; this = STAGING
 * regression alert — different target, complementary, not duplicative.)
 *
 * A red nightly means a real-login / integration / E2E gate regressed against staging:
 * do NOT promote that product to production until it is fixed.
 *
 * Defensive by design: only a definitive 'failure'/'timed_out' conclusion alerts. A GitHub
 * API error, no-run-yet (first nightly hasn't fired), an in-progress run, or a 'cancelled'
 * run all SKIP — a transient API blip must never raise a false alarm.
 *
 * PERSISTENCE GATE (Roger's alerting philosophy, 2026-07-23: "alert only on persistent breakage,
 * transient = noise"). A staging gauntlet can go red for a few minutes on a self-healing blip —
 * e.g. Supabase momentarily rotating its ES256 signing key so an admin auth call 403s — which
 * flaky-retry.mjs then reruns green. We must NOT page on that window. So a failure alerts ONLY
 * once it has PERSISTED past the auto-retry self-heal window: either the run was already retried
 * (run_attempt >= 2 and still red = a rerun didn't fix it), OR it is old enough (> 2h) that
 * flaky-retry's window has elapsed without recovery. A fresh first-attempt failure SKIPS — the
 * auto-fix layer gets its chance first. This is the exact false page from 2026-07-24 (SignalScore
 * attempt-1 JWT teardown blip, reran green minutes later — should never have emailed).
 *
 * Requires DASHBOARD_PAT (GitHub PAT with actions:read). Already provided to the monitor job.
 */

const TIERED_REPOS = [
  'Arivioo/signalscore',
  'Arivioo/ChannelMover',
  'Arivioo/Valrano',
  'Arivioo/ReplyFlow',
  'Arivioo/BoatBuddy',
];

const ghToken = process.env.DASHBOARD_PAT;

for (const repo of TIERED_REPOS) {
  test(`nightly-gauntlet: ${repo} last scheduled staging gauntlet is not failing`, async ({ request }) => {
    test.skip(!ghToken, 'DASHBOARD_PAT not set');

    const res = await request.get(
      `https://api.github.com/repos/${repo}/actions/workflows/deploy.yml/runs?event=schedule&per_page=1`,
      { headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' } },
    );
    test.skip(res.status() !== 200, `GitHub API returned ${res.status()} for ${repo} — skipping to avoid a false alarm`);

    const body = await res.json();
    const runs = body.workflow_runs ?? [];
    test.skip(runs.length === 0, `${repo}: no scheduled gauntlet run yet (nightly schedule not fired)`);

    const latest = runs[0];
    test.skip(latest.status !== 'completed', `${repo}: latest scheduled gauntlet still ${latest.status}`);

    // Only a definitive failure is a candidate; a green/cancelled latest run is healthy.
    const isFail = ['failure', 'timed_out'].includes(latest.conclusion);
    test.skip(!isFail, `${repo}: latest scheduled gauntlet is '${latest.conclusion}' — healthy`);

    // PERSISTENCE GATE — page only once the failure has outlived the auto-retry self-heal window
    // (see header). run_attempt >= 2 → flaky-retry already reran it and it's STILL red = persistent.
    // Otherwise require the failure to be > 2h old so flaky-retry's window has passed.
    const startedAt = latest.run_started_at ?? latest.created_at;
    const ageHours = (Date.now() - new Date(startedAt).getTime()) / 3_600_000;
    const attempt = latest.run_attempt ?? 1;
    const persistent = attempt >= 2 || ageHours >= 2;
    test.skip(
      !persistent,
      `${repo}: scheduled gauntlet failed on attempt ${attempt}, ${ageHours.toFixed(1)}h ago — inside the auto-retry self-heal window, not yet persistent (no page).`,
    );

    expect(
      isFail && persistent,
      `${repo} NIGHTLY GAUNTLET PERSISTENTLY FAILING — a real-login / integration / E2E gate regressed against staging and the auto-retry did NOT recover it (attempt ${attempt}, ${ageHours.toFixed(1)}h, ${latest.html_url}). Do NOT promote ${repo} to production until fixed.`,
    ).toBe(false);
  });
}
