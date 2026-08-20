#!/usr/bin/env node
/**
 * Unit tests for scripts/prod-deploy-guard.mjs — the guarded PROD edge-function deploy path.
 * Covers: arg validation, allowlist refusal, daily-cap enforcement, repo preflight (dirty /
 * out-of-sync) and the dry-run happy path. NEVER performs a real deploy: every spawn either
 * fails before step 5 or runs with --dry-run (no deploy, no probe, no email).
 * Run: node test/prod-deploy-guard.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { spawnSync, execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { parseArgs, checkAllowlist, loadCapState } from '../scripts/prod-deploy-guard.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'prod-deploy-guard.mjs')
const TODAY = new Date().toISOString().slice(0, 10)

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

// Spawn the CLI; returns {status, out}. Env keeps SUPABASE_ACCESS_TOKEN unset on purpose.
function run(args, env = {}) {
  const e = { ...process.env, ...env }
  delete e.SUPABASE_ACCESS_TOKEN
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8', env: e, timeout: 60_000 })
  return { status: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}

function git(repo, args) {
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'pipe' })
}

// Build a temp git repo with an in-sync bare `origin` and one committed edge function.
function makeRepo(fnName) {
  const base = mkdtempSync(join(tmpdir(), 'pdg-'))
  const bare = join(base, 'origin.git')
  const repo = join(base, 'repo')
  execFileSync('git', ['init', '--bare', '-b', 'master', bare], { stdio: 'pipe' })
  execFileSync('git', ['init', '-b', 'master', repo], { stdio: 'pipe' })
  mkdirSync(join(repo, 'supabase', 'functions', fnName), { recursive: true })
  writeFileSync(join(repo, 'supabase', 'functions', fnName, 'index.ts'), '// test fn\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'init'])
  git(repo, ['remote', 'add', 'origin', bare])
  git(repo, ['push', '-u', 'origin', 'master'])
  return { base, bare, repo }
}

const VALID = ['--project', 'xoecpzfsskalvjrtcbbl', '--function', 'monitoring-board', '--repo', 'R', '--probe-url', 'https://example.com/hook']

// ── parseArgs (pure) ─────────────────────────────────────────────────────────
t('parseArgs: happy path incl. repeatable --probe-header', () => {
  const { error, args } = parseArgs([...VALID, '--probe-expect', 'ok', '--probe-header', 'Authorization: Bearer x', '--probe-header', 'X-A: 1', '--probe-method', 'post', '--note', 'why', '--dry-run'])
  assert.ifError(error)
  assert.equal(args.project, 'xoecpzfsskalvjrtcbbl')
  assert.deepEqual(args.probeHeaders, ['Authorization: Bearer x', 'X-A: 1'])
  assert.equal(args.probeMethod, 'POST')
  assert.equal(args.dryRun, true)
})
t('parseArgs: missing required flag -> error', () => {
  assert.match(parseArgs(['--project', 'x']).error, /--function/)
})
t('parseArgs: bad header / bad method / non-http probe url -> error', () => {
  assert.match(parseArgs([...VALID, '--probe-header', 'noColon']).error, /--probe-header/)
  assert.match(parseArgs([...VALID, '--probe-method', 'DELETE']).error, /--probe-method/)
  assert.match(parseArgs([...VALID, '--probe-url', 'ftp://x']).error, /probe-url/)
})

// ── checkAllowlist (pure) ────────────────────────────────────────────────────
t('allowlist: the 3 approved combos pass', () => {
  assert.ok(checkAllowlist('dqmhsdzldkxngwjrxois', 'monitor-sync-health').ok)
  assert.ok(checkAllowlist('xoecpzfsskalvjrtcbbl', 'monitoring-board').ok)
  assert.ok(checkAllowlist('xoecpzfsskalvjrtcbbl', 'health-monitor').ok)
})
t('allowlist: product functions are NEVER allowed, even on an allowlisted project', () => {
  for (const fn of ['auth', 'payments', 'email', 'connect-platform', 'process-queue']) {
    assert.equal(checkAllowlist('xoecpzfsskalvjrtcbbl', fn).ok, false, fn)
    assert.equal(checkAllowlist('dqmhsdzldkxngwjrxois', fn).ok, false, fn)
  }
})
t('allowlist: unknown project refused; right function on wrong project refused', () => {
  assert.equal(checkAllowlist('aaaaaaaaaaaaaaaaaaaa', 'monitoring-board').ok, false)
  assert.equal(checkAllowlist('dqmhsdzldkxngwjrxois', 'monitoring-board').ok, false)
})

// ── CLI: arg validation + refusal exit codes ─────────────────────────────────
t('CLI: no args -> exit 1 with usage', () => {
  const r = run([])
  assert.equal(r.status, 1)
  assert.match(r.out, /Usage: node scripts\/prod-deploy-guard\.mjs/)
})
t('CLI: non-allowlisted function -> exit 1, lists what IS allowed', () => {
  const r = run(['--project', 'dqmhsdzldkxngwjrxois', '--function', 'process-queue', '--repo', '/tmp/x', '--probe-url', 'https://example.com', '--dry-run'])
  assert.equal(r.status, 1)
  assert.match(r.out, /not allowlisted/)
  assert.match(r.out, /monitor-sync-health/)
  assert.match(r.out, /monitoring-board, health-monitor/)
})
t('CLI: non-allowlisted project -> exit 1', () => {
  const r = run(['--project', 'bbbbbbbbbbbbbbbbbbbb', '--function', 'monitoring-board', '--repo', '/tmp/x', '--probe-url', 'https://example.com', '--dry-run'])
  assert.equal(r.status, 1)
  assert.match(r.out, /not allowlisted/)
})

// ── CLI: daily cap ───────────────────────────────────────────────────────────
t('CLI: cap at 2/2 today -> refused before any repo/CI work; cap state untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdg-cap-'))
  const stateFile = join(dir, 'prod-deploys.json')
  writeFileSync(stateFile, JSON.stringify({ [TODAY]: 2 }))
  const r = run([...VALID.filter((_, i) => i < 2 || i > 3), '--project', 'xoecpzfsskalvjrtcbbl', '--function', 'health-monitor', '--repo', '/tmp/x', '--probe-url', 'https://example.com'], { PROD_DEPLOYS_STATE: stateFile })
  assert.equal(r.status, 1)
  assert.match(r.out, /daily cap reached: 2\/2/)
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf-8'))[TODAY], 2, 'refused attempt must NOT consume cap')
})
t('cap state: stale day keys load fine (new day resets the count)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdg-cap-'))
  const stateFile = join(dir, 'prod-deploys.json')
  writeFileSync(stateFile, JSON.stringify({ '2000-01-01': 2 }))
  assert.equal(loadCapState(stateFile)['2000-01-01'], 2)
  assert.equal(loadCapState(stateFile)[TODAY] || 0, 0)
})

// ── CLI: repo preflight + dry-run happy path ─────────────────────────────────
t('CLI: --repo not a git repo -> exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdg-notgit-'))
  const stateFile = join(dir, 'state.json')
  const r = run(['--project', 'xoecpzfsskalvjrtcbbl', '--function', 'monitoring-board', '--repo', dir, '--probe-url', 'https://example.com', '--dry-run'], { PROD_DEPLOYS_STATE: stateFile })
  assert.equal(r.status, 1)
  assert.match(r.out, /not a git repository/)
})
t('CLI: uncommitted changes in supabase/functions/<name> -> exit 1', () => {
  const { repo, base } = makeRepo('monitoring-board')
  writeFileSync(join(repo, 'supabase', 'functions', 'monitoring-board', 'index.ts'), '// dirty\n')
  const r = run(['--project', 'xoecpzfsskalvjrtcbbl', '--function', 'monitoring-board', '--repo', repo, '--probe-url', 'https://example.com', '--dry-run'], { PROD_DEPLOYS_STATE: join(base, 'state.json') })
  assert.equal(r.status, 1)
  assert.match(r.out, /uncommitted changes/)
})
t('CLI: origin ahead of local HEAD -> exit 1 (must be exactly the committed code)', () => {
  const { bare, repo, base } = makeRepo('monitoring-board')
  // advance origin: clone, commit, push
  const other = join(base, 'other')
  execFileSync('git', ['clone', bare, other], { stdio: 'pipe' })
  writeFileSync(join(other, 'supabase', 'functions', 'monitoring-board', 'index.ts'), '// v2\n')
  git(other, ['add', '-A'])
  git(other, ['commit', '-m', 'v2'])
  git(other, ['push', 'origin', 'master'])
  const r = run(['--project', 'xoecpzfsskalvjrtcbbl', '--function', 'monitoring-board', '--repo', repo, '--probe-url', 'https://example.com', '--dry-run'], { PROD_DEPLOYS_STATE: join(base, 'state.json') })
  assert.equal(r.status, 1)
  assert.match(r.out, /!= origin\/master/)
})
t('CLI: dry-run happy path -> exit 0, prints WOULD deploy, no deploy/email/cap write', () => {
  const { repo, base } = makeRepo('monitoring-board')
  const stateFile = join(base, 'prod-deploys.json')
  const r = run(['--project', 'xoecpzfsskalvjrtcbbl', '--function', 'monitoring-board', '--repo', repo, '--probe-url', 'https://example.com/hook', '--probe-expect', 'ok', '--note', 'test note', '--dry-run'], { PROD_DEPLOYS_STATE: stateFile })
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /allowlist OK/)
  assert.match(r.out, /daily cap OK: 0\/2/)
  assert.match(r.out, /in sync with origin/)
  assert.match(r.out, /no CI — proceeding on probe-verification only/)
  assert.match(r.out, /WOULD now/)
  assert.match(r.out, /supabase functions deploy monitoring-board --project-ref xoecpzfsskalvjrtcbbl --use-api/)
  assert.match(r.out, /no deploy, no probe, no email/)
  assert.equal(existsSync(stateFile), false, 'dry-run must not write cap state')
})
t('CLI: dry-run works without SUPABASE_ACCESS_TOKEN (real run would fail early)', () => {
  const { repo, base } = makeRepo('health-monitor')
  const r = run(['--project', 'xoecpzfsskalvjrtcbbl', '--function', 'health-monitor', '--repo', repo, '--probe-url', 'https://example.com', '--dry-run'], { PROD_DEPLOYS_STATE: join(base, 's.json') })
  assert.equal(r.status, 0, r.out)
})

console.log(`\n${n} assertions passed.`)
