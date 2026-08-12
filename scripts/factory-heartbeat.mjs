#!/usr/bin/env node
/**
 * factory-heartbeat.mjs — upsert one machine_state row into the shared BackOffice
 * Supabase so the Factory Cockpit's factory_state view covers the outside-DB machines.
 *
 * Modes:
 *   node scripts/factory-heartbeat.mjs monitoring   (hourly, from monitor.yml)
 *   node scripts/factory-heartbeat.mjs kb           (daily, from dashboard-update.yml)
 *
 * Env (all already repo secrets): BACKOFFICE_SUPABASE_URL, BACKOFFICE_SERVICE_ROLE_KEY.
 * kb mode additionally: FLEET_READ_TOKEN (classic PAT, repo:read).
 *
 * Best-effort BY DESIGN: logs and exits 0 on any failure — a heartbeat writer must
 * never fail the monitor it rides on. Staleness is the failure signal (the cockpit
 * tile shows "zuletzt aktiv", and alert flips when data goes stale).
 */

const SUPABASE_URL = process.env.BACKOFFICE_SUPABASE_URL
const SERVICE_KEY = process.env.BACKOFFICE_SERVICE_ROLE_KEY
const FLEET_TOKEN = process.env.FLEET_READ_TOKEN

const HOURS_STALE_MONITORING = 36 // automation-status.json regenerates daily
const DAYS_STALE_KB = 3 // kb(daily) commits should land at least this often

async function upsert(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/machine_state?on_conflict=kind`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
  })
  if (!res.ok) throw new Error(`upsert ${row.kind}: HTTP ${res.status} ${await res.text()}`)
  console.log(`machine_state upserted: ${row.kind} -> ${row.status} (pending=${row.pending_action_count}, alert=${row.alert})`)
}

async function monitoring() {
  const res = await fetch('https://backoffice.predivo.ch/automation-status.json')
  if (!res.ok) throw new Error(`automation-status.json HTTP ${res.status}`)
  const report = await res.json()
  const generatedAt = new Date(report.generatedAt)
  const ageHours = (Date.now() - generatedAt.getTime()) / 3.6e6
  const red = report.summary?.red ?? 0
  const escalations = report.summary?.escalations?.length ?? 0
  const stale = ageHours > HOURS_STALE_MONITORING
  await upsert({
    kind: 'monitoring',
    name: 'Production Monitoring',
    status: stale ? 'stale' : red > 0 ? 'attention' : 'ok',
    last_run_at: generatedAt.toISOString(),
    pending_action_count: red,
    alert: escalations > 0 || stale,
    meta: {
      source: 'automation-status.json',
      green: report.summary?.green ?? null,
      red,
      unknown: report.summary?.unknown ?? null,
      escalations: (report.summary?.escalations ?? []).slice(0, 10),
      age_hours: Math.round(ageHours),
    },
  })
}

async function kb() {
  if (!FLEET_TOKEN) throw new Error('FLEET_READ_TOKEN not set')
  const res = await fetch(
    'https://api.github.com/repos/Arivioo/backoffice/commits?path=src/data/knowledge/videos.ts&per_page=1',
    { headers: { Authorization: `Bearer ${FLEET_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'production-monitor' } }
  )
  if (!res.ok) throw new Error(`github commits HTTP ${res.status}`)
  const commits = await res.json()
  const last = commits[0]
  if (!last) throw new Error('no commits found for videos.ts')
  const lastAt = new Date(last.commit.committer.date)
  const ageDays = (Date.now() - lastAt.getTime()) / 8.64e7
  const stale = ageDays > DAYS_STALE_KB
  await upsert({
    kind: 'kb',
    name: 'KB Self-Learning',
    status: stale ? 'stale' : 'ok',
    last_run_at: lastAt.toISOString(),
    pending_action_count: 0,
    alert: stale,
    meta: {
      source: 'github:Arivioo/backoffice src/data/knowledge/videos.ts',
      last_commit_sha: last.sha.slice(0, 7),
      last_commit_message: last.commit.message.split('\n')[0],
      age_days: Math.round(ageDays * 10) / 10,
    },
  })
}

async function main() {
  const mode = process.argv[2]
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('BACKOFFICE_SUPABASE_URL / BACKOFFICE_SERVICE_ROLE_KEY not set')
  if (mode === 'monitoring') await monitoring()
  else if (mode === 'kb') await kb()
  else throw new Error(`unknown mode: ${mode} (expected monitoring|kb)`)
}

main().catch((err) => {
  console.error(`factory-heartbeat failed (non-fatal): ${err.message}`)
  process.exit(0) // best-effort: never fail the host workflow
})
