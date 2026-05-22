import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser } from '../../lib/auth'

const SITE_URL = process.env.ARIVIOO_URL || 'https://arivioo.com'
const SUPABASE_URL = process.env.ARIVIOO_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.ARIVIOO_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.ARIVIOO_ANON_KEY!
const TEST_EMAIL = process.env.TEST_EMAIL || 'healthcheck-test@predivo.ch'

test.describe('Arivioo — Production Monitor', () => {
  test('landing page loads', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('full login works and dashboard loads', async ({ page }) => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
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

  test('site identity — title contains arivioo', async ({ page }) => {
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })
    const title = await page.title()
    const body = await page.textContent('body')
    const combined = `${title} ${body}`.toLowerCase()
    expect(combined, 'arivioo.com must contain "arivioo" branding').toContain('arivioo')
  })
})
