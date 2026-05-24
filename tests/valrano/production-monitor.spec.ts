import { test, expect } from '@playwright/test'

const SITE_URL = process.env.VALRANO_URL || 'https://valrano.com'
const SUPABASE_URL = process.env.VALRANO_SUPABASE_URL || 'https://mkdeftmubrkseyrrbzvp.supabase.co'

test.describe('Valrano — Production Monitor', () => {
  test('landing page loads', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('site identity — title contains Valrano', async ({ page }) => {
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })
    const title = await page.title()
    const body = await page.textContent('body')
    const combined = `${title} ${body}`.toLowerCase()
    expect(combined, 'valrano.com must contain "valrano" branding').toContain('valrano')
  })

  test('no console errors on landing page', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)
    const criticalErrors = errors.filter(
      (e) => !e.includes('favicon') && !e.includes('manifest') && !e.includes('third-party') && !e.includes('X-Frame-Options'),
    )
    expect(criticalErrors, `Console errors: ${criticalErrors.join('; ')}`).toHaveLength(0)
  })

  // ── Edge function reachability — catches missing deploys after migration ──

  test('send-auth-email edge function is reachable', async ({ request }) => {
    const response = await request.fetch(
      `${SUPABASE_URL}/functions/v1/send-auth-email`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {},
      }
    )
    const status = response.status()
    expect(
      status !== 404 && status !== 500,
      `send-auth-email returned ${status} — not deployed or crashed`
    ).toBe(true)
  })

  test.describe('Edge Functions Reachable', () => {
    const ALL_EDGE_FUNCTIONS = [
      'advance-approval',
      'ai-chat',
      'analyze-accounting-profile',
      'billing-portal',
      'check-publication',
      'company-lookup',
      'compute-comparability',
      'delete-account',
      'deliver-document',
      'digest-company-news',
      'download-catalog-item',
      'download-report',
      'enrich-company',
      'extract-kpis',
      'extract-report-context',
      'fetch-company-news',
      'generate-benchmark',
      'generate-from-google-template',
      'generate-from-template',
      'generate-insights',
      'generate-report',
      'google-auth-callback',
      'google-auth-url',
      'insights-digest',
      'monitor-publications',
      'normalize-kpis',
      'parse-template',
      'pipeline-orchestrator',
      'render-benchmark-pdf',
      'request-demo',
      'resolve-company-website',
      'scan-ir-page',
      'self-benchmark',
      'send-auth-email',
      'send-document-notification',
      'send-welcome',
      'stripe-webhook',
      'suggest-competitors',
      'suggest-ir-url',
      'suggest-publication-dates',
      'upload-report',
    ]

    for (const fn of ALL_EDGE_FUNCTIONS) {
      test(`edge function ${fn} is deployed`, async ({ request }) => {
        const response = await request.fetch(
          `${SUPABASE_URL}/functions/v1/${fn}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: {},
          }
        )
        const status = response.status()
        // 200/400/401/403 = function exists. 404 = NOT deployed. 500 = crashed.
        expect(
          status !== 404 && status !== 500,
          `Edge function "${fn}" returned ${status} — not deployed or crashed`
        ).toBe(true)
      })
    }
  })
})
