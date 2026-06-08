import { test, expect } from '@playwright/test';

/**
 * Supabase Keep-Alive — pings every free-tier project's GraphQL endpoint
 * to prevent automatic pausing. Runs as part of the hourly production monitor.
 *
 * Uses POST /graphql/v1 with { __typename } which executes a real SQL query
 * via pg_graphql — the ONLY request type Supabase counts as database activity.
 */

interface SupabaseProject {
  name: string;
  url: string;
  anonKey: string;
}

function getProjects(): SupabaseProject[] {
  const projects: SupabaseProject[] = [];

  const mapping: Record<string, { urlEnv: string; keyEnv: string }> = {
    'BackOffice':              { urlEnv: 'BACKOFFICE_SUPABASE_URL',            keyEnv: 'BACKOFFICE_ANON_KEY' },
    'BackOffice Staging':      { urlEnv: 'BACKOFFICE_STAGING_SUPABASE_URL',    keyEnv: 'BACKOFFICE_STAGING_ANON_KEY' },
    'ScoutCopilot':            { urlEnv: 'SCOUTCOPILOT_SUPABASE_URL',          keyEnv: 'SCOUTCOPILOT_ANON_KEY' },
    'ChannelMover':            { urlEnv: 'YTMIGRATION_SUPABASE_URL',           keyEnv: 'YTMIGRATION_ANON_KEY' },
    'ReplyFlow':               { urlEnv: 'REPLYFLOW_SUPABASE_URL',             keyEnv: 'REPLYFLOW_ANON_KEY' },
    'ReplyFlow Staging':       { urlEnv: 'REPLYFLOW_STAGING_SUPABASE_URL',     keyEnv: 'REPLYFLOW_STAGING_ANON_KEY' },
    'ShipSolo':                { urlEnv: 'SHIPSOLO_SUPABASE_URL',              keyEnv: 'SHIPSOLO_ANON_KEY' },
    'BelegPilot':              { urlEnv: 'BELEGPILOT_SUPABASE_URL',            keyEnv: 'BELEGPILOT_ANON_KEY' },
    'Arivioo':                 { urlEnv: 'ARIVIOO_SUPABASE_URL',               keyEnv: 'ARIVIOO_ANON_KEY' },
    'LaunchReady':             { urlEnv: 'LAUNCHREADY_SUPABASE_URL',           keyEnv: 'LAUNCHREADY_ANON_KEY' },
    'SignalScore':             { urlEnv: 'SIGNALSCORE_SUPABASE_URL',           keyEnv: 'SIGNALSCORE_ANON_KEY' },
    'SignalScore Staging':     { urlEnv: 'SIGNALSCORE_STAGING_SUPABASE_URL',   keyEnv: 'SIGNALSCORE_STAGING_ANON_KEY' },
    'Valrano':                 { urlEnv: 'VALRANO_SUPABASE_URL',               keyEnv: 'VALRANO_ANON_KEY' },
    'Valrano Staging':         { urlEnv: 'VALRANO_STAGING_SUPABASE_URL',       keyEnv: 'VALRANO_STAGING_ANON_KEY' },
    'APIs':                    { urlEnv: 'APIS_SUPABASE_URL',                  keyEnv: 'APIS_ANON_KEY' },
    'BeizeJassTour':           { urlEnv: 'JASSTOUR_SUPABASE_URL',              keyEnv: 'JASSTOUR_ANON_KEY' },
    'SignalForgeAI':           { urlEnv: 'SIGNALFORGE_SUPABASE_URL',           keyEnv: 'SIGNALFORGE_ANON_KEY' },
    'BoatBuddy':               { urlEnv: 'BOATBUDDY_SUPABASE_URL',             keyEnv: 'BOATBUDDY_ANON_KEY' },
    'BoatBuddy Staging':       { urlEnv: 'BOATBUDDY_STAGING_SUPABASE_URL',     keyEnv: 'BOATBUDDY_STAGING_ANON_KEY' },
  };

  for (const [name, { urlEnv, keyEnv }] of Object.entries(mapping)) {
    const url = process.env[urlEnv];
    const anonKey = process.env[keyEnv];
    if (url && anonKey) {
      projects.push({ name, url, anonKey });
    }
  }

  return projects;
}

const projects = getProjects();

for (const project of projects) {
  test(`keep-alive: ${project.name}`, async ({ request }) => {
    const response = await request.post(`${project.url}/graphql/v1`, {
      headers: {
        'apikey': project.anonKey,
        'Authorization': `Bearer ${project.anonKey}`,
        'Content-Type': 'application/json',
      },
      data: { query: '{ __typename }' },
    });

    expect(response.status(), `${project.name} GraphQL ping failed — database may be paused`).toBe(200);
  });
}

test('keep-alive: at least 16 projects configured', () => {
  expect(projects.length, `Only ${projects.length} projects configured — check env vars`).toBeGreaterThanOrEqual(16);
});
