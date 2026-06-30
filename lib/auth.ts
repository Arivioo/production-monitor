import { createClient } from '@supabase/supabase-js'
import { Page } from '@playwright/test'

interface LoginConfig {
  supabaseUrl: string
  serviceRoleKey: string
  anonKey: string
  testEmail: string
  siteUrl: string
}

/**
 * Performs a real browser login using a server-generated magic link:
 * 1. Generates a magic link via admin API (no email sent)
 * 2. Navigates to the magic link URL (like clicking a link in an email)
 * 3. Supabase verifies the token and redirects to the site with session params
 * 4. The app picks up the session and navigates to dashboard
 *
 * This tests the ENTIRE auth pipeline: token generation, verification,
 * session creation, frontend auth listener, and redirect logic.
 */
export async function loginViaMagicLink(page: Page, config: LoginConfig): Promise<void> {
  const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: config.testEmail,
    options: {
      redirectTo: config.siteUrl,
    },
  })

  if (error) throw new Error(`generateLink failed: ${error.message}`)
  if (!data?.properties?.action_link) throw new Error('No action_link in response')

  // Navigate to the magic link — Supabase verifies the token and redirects
  // to the site with #access_token=...&refresh_token=... in the URL hash
  await page.goto(data.properties.action_link, { waitUntil: 'networkidle' })

  // Wait for redirect away from supabase.co to the actual app
  await page.waitForURL((url) => !url.hostname.includes('supabase.co'), { timeout: 15_000 })
}

/**
 * Creates a test user if it doesn't exist.
 */
export async function ensureTestUser(
  supabaseUrl: string,
  serviceRoleKey: string,
  email: string,
): Promise<void> {
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { error } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  })

  if (error && !error.message.includes('already been registered') && !error.message.includes('already exists')) {
    throw new Error(`Failed to create test user: ${error.message}`)
  }
}

/**
 * Forces the monitor's test user onto a fully-entitled plan so feature-gated
 * pages render their real content instead of an upsell screen.
 *
 * WHY: tests that navigate to plan-gated features (e.g. Analytics = Pro+) must
 * NOT depend on whatever plan state the prod DB happens to hold — otherwise a
 * future gating change silently turns a passing test into a false alarm. By
 * seeding the precondition here, the test always establishes the state it needs.
 * Defaults to the highest tier so ANY gate is satisfied.
 *
 * Generic over the subscription table/columns since schemas differ per project.
 */
export async function setUserPlan(
  supabaseUrl: string,
  serviceRoleKey: string,
  email: string,
  opts: {
    plan: string
    status?: string
    table?: string
    planColumn?: string
    statusColumn?: string
    currentPeriodEnd?: string | null
  },
): Promise<void> {
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Resolve user_id by email (admin API has no getUserByEmail).
  let userId: string | undefined
  for (let page = 1; page <= 10 && !userId; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw new Error(`setUserPlan listUsers failed: ${error.message}`)
    userId = data.users.find((u) => (u.email || '').toLowerCase() === email.toLowerCase())?.id
    if (data.users.length < 1000) break
  }
  if (!userId) throw new Error(`setUserPlan: no auth user found for ${email}`)

  const table = opts.table ?? 'subscriptions'
  const row: Record<string, unknown> = {
    user_id: userId,
    [opts.planColumn ?? 'plan']: opts.plan,
  }
  if (opts.status) row[opts.statusColumn ?? 'status'] = opts.status
  if (opts.currentPeriodEnd !== undefined) row.current_period_end = opts.currentPeriodEnd
  else row.current_period_end = '2099-12-31T00:00:00+00:00'

  const { error } = await supabase.from(table).upsert(row, { onConflict: 'user_id' })
  if (error) throw new Error(`setUserPlan upsert into ${table} failed: ${error.message}`)
}
