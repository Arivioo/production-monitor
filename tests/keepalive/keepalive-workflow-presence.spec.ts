import { test, expect } from '@playwright/test';

/**
 * Verifies that every repo with a free-tier Supabase project has a
 * keep-alive.yml GitHub Actions workflow. Catches silent deletions
 * caused by force-pushes, rebases, or repo restructures.
 *
 * Requires DASHBOARD_PAT env var (GitHub PAT with repo read access).
 */

const REPOS_REQUIRING_KEEPALIVE = [
  'Arivioo/ReplyFlow',
  'Arivioo/backoffice',
  'Arivioo/belegpilot',
  'Arivioo/ChannelMover',
  'Arivioo/ScoutCopilot',
  'Arivioo/signalscore',
  'Arivioo/launchready',
  'Arivioo/Valrano',
  'Arivioo/api-dashboard',
  'Arivioo/SignalForgeAi',
  'Arivioo/BoatBuddy',
  'Arivioo/jass-tour-ui-kit',
  'Arivioo/Cursor_Arivioo',
];

const ghToken = process.env.DASHBOARD_PAT;

for (const repo of REPOS_REQUIRING_KEEPALIVE) {
  test(`workflow-presence: ${repo} has keep-alive.yml`, async ({ request }) => {
    test.skip(!ghToken, 'DASHBOARD_PAT not set');

    const response = await request.get(
      `https://api.github.com/repos/${repo}/contents/.github/workflows/keep-alive.yml`,
      {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    expect(
      response.status(),
      `${repo} is missing keep-alive.yml — workflow was likely deleted by a later commit`
    ).toBe(200);
  });
}
