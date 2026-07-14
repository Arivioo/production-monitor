#!/usr/bin/env node
/**
 * Nightly staging<->prod drift detection for the Supabase-backed products.
 *
 * Catches the classes no test run ever sees (investigation report §8):
 *  - schema drift: migrations applied to one environment only (the CHECK
 *    constraint that silently killed Auto-Pilot; staging at 1 of prod's 9 crons)
 *  - cron drift: job present in prod but not staging (or vice versa)
 *  - placeholder rot: a live cron row containing '<<' (e.g. <<CRON_SECRET>>)
 *    or a dead old project ref — fire-and-forget pg_cron masks these forever.
 *
 * Uses the Supabase Management API query endpoint with per-product PATs.
 * Read-only. Exits 1 on any drift — the workflow failure IS the alert.
 */

const PRODUCTS = [
  {
    name: 'ReplyFlow',
    patEnv: 'SUPABASE_TOKEN_REPLYFLOW',
    prod: 'dqmhsdzldkxngwjrxois',
    staging: 'cuvqzwvyovxvvvuddtjd',
  },
  {
    name: 'ChannelMover',
    patEnv: 'SUPABASE_TOKEN_CHANNELMOVER',
    prod: 'qswluvqunswggfmesdcs',
    staging: 'wlbykamxcgwduixcwadn',
  },
  {
    name: 'SignalScore',
    patEnv: 'SUPABASE_TOKEN_MUELLER',
    prod: 'ogdpgufptemcgyszmjek',
    staging: 'blfnyxwcriyxvsaubiqb',
  },
]

const SCHEMA_SQL = `
  SELECT table_name || '.' || column_name || ':' || data_type AS entry
  FROM information_schema.columns
  WHERE table_schema = 'public'
  ORDER BY 1`

const CONSTRAINT_SQL = `
  SELECT conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid) AS entry
  FROM pg_constraint
  WHERE connamespace = 'public'::regnamespace AND contype IN ('c','f','u','p')
  ORDER BY 1`

const CRON_SQL = `
  SELECT jobname || ' [' || schedule || ']' AS entry, command
  FROM cron.job WHERE active ORDER BY 1`

const failures = []
const fail = (m) => { failures.push(m); console.error(`  DRIFT ${m}`) }
const ok = (m) => console.log(`  OK  ${m}`)

async function query(ref, pat, sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  if (!res.ok) throw new Error(`query(${ref}) HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`)
  return res.json()
}

function diffSets(prodRows, stagingRows) {
  const p = new Set(prodRows)
  const s = new Set(stagingRows)
  return {
    prodOnly: [...p].filter((x) => !s.has(x)),
    stagingOnly: [...s].filter((x) => !p.has(x)),
  }
}

for (const { name, patEnv, prod, staging } of PRODUCTS) {
  console.log(`\n== ${name} (prod ${prod} vs staging ${staging})`)
  const pat = process.env[patEnv]
  if (!pat) { fail(`${name}: env ${patEnv} not set`); continue }

  try {
    // 1. Schema columns
    const [pCols, sCols] = await Promise.all([
      query(prod, pat, SCHEMA_SQL),
      query(staging, pat, SCHEMA_SQL),
    ])
    const colDiff = diffSets(pCols.map((r) => r.entry), sCols.map((r) => r.entry))
    if (colDiff.prodOnly.length || colDiff.stagingOnly.length) {
      fail(`${name} schema: ${colDiff.prodOnly.length} column(s) only in PROD, ${colDiff.stagingOnly.length} only in STAGING`)
      colDiff.prodOnly.slice(0, 10).forEach((e) => console.error(`      prod-only:    ${e}`))
      colDiff.stagingOnly.slice(0, 10).forEach((e) => console.error(`      staging-only: ${e}`))
    } else ok(`${name} schema columns identical (${pCols.length})`)

    // 2. Constraints (CHECK/FK/UNIQUE/PK definitions)
    const [pCon, sCon] = await Promise.all([
      query(prod, pat, CONSTRAINT_SQL),
      query(staging, pat, CONSTRAINT_SQL),
    ])
    const conDiff = diffSets(pCon.map((r) => r.entry), sCon.map((r) => r.entry))
    if (conDiff.prodOnly.length || conDiff.stagingOnly.length) {
      fail(`${name} constraints: ${conDiff.prodOnly.length} only in PROD, ${conDiff.stagingOnly.length} only in STAGING`)
      conDiff.prodOnly.slice(0, 6).forEach((e) => console.error(`      prod-only:    ${e.slice(0, 140)}`))
      conDiff.stagingOnly.slice(0, 6).forEach((e) => console.error(`      staging-only: ${e.slice(0, 140)}`))
    } else ok(`${name} constraints identical (${pCon.length})`)

    // 3. Cron jobs: parity + placeholder rot (checked per environment)
    const [pCron, sCron] = await Promise.all([
      query(prod, pat, CRON_SQL),
      query(staging, pat, CRON_SQL),
    ])
    const cronDiff = diffSets(pCron.map((r) => r.entry), sCron.map((r) => r.entry))
    if (cronDiff.prodOnly.length || cronDiff.stagingOnly.length) {
      fail(`${name} cron jobs differ — prod-only: [${cronDiff.prodOnly.join('; ')}], staging-only: [${cronDiff.stagingOnly.join('; ')}]`)
    } else ok(`${name} cron jobs in parity (${pCron.length})`)

    for (const [env, rows] of [['PROD', pCron], ['STAGING', sCron]]) {
      for (const row of rows) {
        if ((row.command ?? '').includes('<<')) {
          fail(`${name} ${env} cron '${row.entry}' contains an unsubstituted <<placeholder>>`)
        }
      }
    }
  } catch (e) {
    fail(`${name}: ${String(e).slice(0, 200)}`)
  }
}

console.log('')
if (failures.length) {
  console.error(`DRIFT DETECTED (${failures.length} finding(s)) — staging is not a truthful rehearsal of prod until resolved.`)
  process.exitCode = 1
} else {
  console.log('No drift across all products.')
}
