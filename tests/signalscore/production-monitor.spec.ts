import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser } from '../../lib/auth'

const SITE_URL = process.env.SIGNALSCORE_URL || 'https://signalscore.ch'
const SUPABASE_URL = process.env.SIGNALSCORE_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.SIGNALSCORE_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.SIGNALSCORE_ANON_KEY!
const TEST_EMAIL = process.env.TEST_EMAIL || 'healthcheck-test@predivo.ch'

test.describe('SignalScore — Production Monitor', () => {
  test.beforeAll(async () => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
  })

  test('site loads', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('full login works and dashboard loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')
    const url = page.url()
    expect(url).not.toContain('/auth')
  })

  test('methodology page loads', async ({ page }) => {
    await page.goto(`${SITE_URL}/methodology`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
  })
})
