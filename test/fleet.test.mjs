#!/usr/bin/env node
// Tests the fleet registry helper (lib/fleet.mjs). The load-bearing assertion is the SAFETY one:
// any DB failure must fall back to the full hardcoded fleet, never a shrunken list (no blind spot).
// Run: node test/fleet.test.mjs   (optionally with BACKOFFICE_SUPABASE_URL/KEY set to test the DB path)
import assert from 'node:assert'
import { getFleet, FALLBACK_FLEET } from '../lib/fleet.mjs'

let pass = 0
const ok = (m) => { console.log('  ok -', m); pass++ }

async function run() {
  // 1) SAFETY: with no DB env, getFleet falls back to the full hardcoded fleet.
  const savedUrl = process.env.BACKOFFICE_SUPABASE_URL
  const savedKey = process.env.BACKOFFICE_SERVICE_ROLE_KEY
  delete process.env.BACKOFFICE_SUPABASE_URL
  delete process.env.BACKOFFICE_SERVICE_ROLE_KEY
  const fb = await getFleet()
  assert.equal(fb.source, 'fallback', 'no-env -> fallback')
  assert.equal(fb.fleet.length, FALLBACK_FLEET.length, 'fallback returns the FULL fleet (no shrink)')
  assert.ok(fb.fleet.find((p) => p.name === 'ReplyFlow'), 'fallback includes ReplyFlow')
  ok(`no DB env -> fallback with all ${fb.fleet.length} products (fail-safe)`)

  // 2) SAFETY: a bad URL (network/HTTP error) also falls back, never throws.
  process.env.BACKOFFICE_SUPABASE_URL = 'https://invalid.example.doesnotexist'
  process.env.BACKOFFICE_SERVICE_ROLE_KEY = 'x'
  const bad = await getFleet()
  assert.equal(bad.source, 'fallback', 'bad URL -> fallback (no throw)')
  assert.equal(bad.fleet.length, FALLBACK_FLEET.length, 'bad URL still returns the full fleet')
  ok('unreachable DB -> fallback, never throws')

  // restore
  if (savedUrl) process.env.BACKOFFICE_SUPABASE_URL = savedUrl; else delete process.env.BACKOFFICE_SUPABASE_URL
  if (savedKey) process.env.BACKOFFICE_SERVICE_ROLE_KEY = savedKey; else delete process.env.BACKOFFICE_SERVICE_ROLE_KEY

  // 3) DB path (only if real creds are present): getFleet reads fleet_products.
  if (process.env.BACKOFFICE_SUPABASE_URL && process.env.BACKOFFICE_SERVICE_ROLE_KEY) {
    const db = await getFleet()
    assert.ok(db.fleet.length >= 1, 'db path returns rows')
    ok(`live DB path -> source=${db.source}, ${db.fleet.length} products`)
  } else {
    console.log('  (skip DB path - BACKOFFICE_SUPABASE_URL/KEY not set)')
  }
}

run()
  .then(() => { console.log(`\nPASS - ${pass} assertions.`); process.exit(0) })
  .catch((e) => { console.error(`\nFAIL: ${e.message}`); process.exit(1) })
