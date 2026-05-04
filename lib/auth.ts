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
