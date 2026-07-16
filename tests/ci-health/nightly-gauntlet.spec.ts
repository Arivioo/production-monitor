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

    expect(
      ['failure', 'timed_out'],
      `${repo} NIGHTLY GAUNTLET FAILED — a real-login / integration / E2E gate regressed against staging (${latest.html_url}). Do NOT promote ${repo} to production until fixed.`,
    ).not.toContain(latest.conclusion);
  });
}
