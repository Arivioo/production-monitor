// DB-backed fleet registry with a HARDCODED FALLBACK (audit Themes 3+4, 2026-08-15).
//
// getFleet() reads public.fleet_products from the shared BackOffice backend so a launched product
// can be auto-enrolled into monitoring by inserting a row (instead of hand-editing several scripts).
// On ANY failure — missing env, network error, empty/absent table, a disabled key — it FALLS BACK to
// the hardcoded list below. That fallback is the safety property: migrating a reader from its local
// hardcoded array to getFleet() can NEVER lose a product or create a monitoring blind spot, because
// the worst case is exactly today's behavior. Readers migrate to this ONE at a time.
//
// The fallback list is the canonical fleet as of 2026-08-15 (mirror of the array historically
// duplicated in check-gate-coverage.mjs / check-pipeline-drift.mjs). Keep it in sync until every
// reader is migrated and the DB row set is confirmed authoritative; then this becomes a pure safety net.

export const FALLBACK_FLEET = [
  { name: 'ReplyFlow',        repo: 'Arivioo/ReplyFlow',        dir: 'replyflow',        gates: 'required' },
  { name: 'SignalScore',      repo: 'Arivioo/signalscore',      dir: 'signalscore',      gates: 'required' },
  { name: 'ChannelMover',     repo: 'Arivioo/ChannelMover',     dir: 'ChannelMover',     gates: 'required' },
  { name: 'BoatBuddy',        repo: 'Arivioo/BoatBuddy',        dir: 'BoatBuddy',        gates: 'required' },
  { name: 'BackOffice',       repo: 'Arivioo/BackOffice',       dir: 'BackOffice',       gates: 'required' },
  { name: 'Valrano',          repo: 'Arivioo/Valrano',          dir: 'Valrano',          gates: 'required' },
  { name: 'ScoutCopilot',     repo: 'Arivioo/ScoutCopilot',     dir: 'ScoutCopilot',     gates: 'required' },
  { name: 'Distribution-OS',  repo: 'Arivioo/Distribution-OS',  dir: 'Distribution-OS',  gates: 'required' },
  { name: 'launchready',      repo: 'Arivioo/launchready',      dir: 'launchready',      gates: 'deferred' },
  { name: 'arivioo',          repo: 'Arivioo/Cursor_Arivioo',   dir: 'arivioo',          gates: 'required' },
  { name: 'jass-tour-ui-kit', repo: 'Arivioo/jass-tour-ui-kit', dir: 'jass-tour-ui-kit', gates: 'required' },
  { name: 'predivo',          repo: 'Arivioo/predivo',          dir: 'predivo',          gates: 'na' },
]

/**
 * Return the monitored fleet. { source: 'db'|'fallback', fleet: [...], reason? }.
 * NEVER throws — a failure resolves to the hardcoded fallback so callers can't blind-spot.
 */
export async function getFleet({ activeOnly = true } = {}) {
  const url = process.env.BACKOFFICE_SUPABASE_URL
  const key = process.env.BACKOFFICE_SERVICE_ROLE_KEY || process.env.BACKOFFICE_SECRET_KEY
  if (!url || !key) {
    return { source: 'fallback', reason: 'BACKOFFICE_SUPABASE_URL / key not set', fleet: FALLBACK_FLEET }
  }
  try {
    const q = activeOnly ? '?active=eq.true&select=*&order=name.asc' : '?select=*&order=name.asc'
    const res = await fetch(`${url}/rest/v1/fleet_products${q}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    })
    if (!res.ok) throw new Error(`fleet_products HTTP ${res.status}`)
    const rows = await res.json()
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('fleet_products returned no rows')
    return { source: 'db', fleet: rows }
  } catch (e) {
    // Fail SAFE: never let a DB hiccup shrink the monitored fleet.
    return { source: 'fallback', reason: String(e.message || e), fleet: FALLBACK_FLEET }
  }
}
