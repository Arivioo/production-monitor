import type { Page, APIRequestContext } from '@playwright/test'

export interface RouteManifest {
  routes: Array<{ path: string; mustContain?: string[] }>
  notFoundMarkers?: string[]
}

// How long to wait for the client-side app to paint content on a route before
// concluding it is genuinely empty / missing content.
const RENDER_TIMEOUT = 15_000

/**
 * Fetch the deployed monitor-routes.json manifest.
 *
 * On Apache SPA hosting a missing file is NOT a 404 — the SPA fallback serves
 * index.html (HTTP 200, text/html), so a status-only check would let HTML
 * through and res.json() would throw "Unexpected token '<'". We require a real
 * JSON payload (200 + application/json); callers test.skip() when it isn't
 * deployed yet, keeping the monitor green during rollout.
 */
export async function fetchRouteManifest(request: APIRequestContext, siteUrl: string) {
  const res = await request.get(`${siteUrl}/monitor-routes.json`)
  const contentType = res.headers()['content-type'] || ''
  const isJsonManifest = res.status() === 200 && contentType.includes('application/json')
  const manifest: RouteManifest | null = isJsonManifest ? await res.json() : null
  return { isJsonManifest, status: res.status(), contentType, manifest }
}

/**
 * Smoke-test every public route from the manifest. Returns a list of
 * human-readable failure strings (empty array = all good).
 *
 * These apps are CLIENT-SIDE RENDERED: the initial HTML ships an empty #root,
 * so route content only exists after the SPA paints. We navigate with
 * domcontentloaded (fast, and avoids networkidle hanging on a persistent
 * Supabase realtime socket) and then WAIT for the app to actually render
 * before asserting. This is the fix for repeated false alarms: a slow
 * hydration must never be mistaken for missing content. A genuinely broken or
 * empty page still fails — but only after the render timeout elapses.
 *
 * For PasswordGate-protected apps, call `page.addInitScript(...)` to unlock
 * before invoking this — init scripts persist across the navigations here.
 */
export async function checkPublicRoutes(
  page: Page,
  siteUrl: string,
  manifest: RouteManifest,
): Promise<string[]> {
  const routes = manifest.routes ?? []
  const notFoundMarkers = manifest.notFoundMarkers ?? ['Page Not Found']
  const failures: string[] = []

  for (const { path: routePath, mustContain } of routes) {
    await page.goto(`${siteUrl}${routePath}`, { waitUntil: 'domcontentloaded' })

    // Wait for the SPA route to finish rendering. We can't just check
    // "body length >= 50": the static index.html shell (skip-link + footer)
    // already exceeds that BEFORE the route component mounts, so a length gate
    // reads a half-rendered page and misses both empty-detection and the
    // not-found marker. Instead wait until the body text grows past the shell
    // and then STABILISES (unchanged between polls) — this also handles
    // lazy-loaded route chunks. Best-effort: if it never stabilises we fall
    // through and let the assertions below judge whatever did render.
    try {
      await page.waitForFunction(
        () => {
          const w = window as unknown as { __pmPrevLen?: number }
          const len = (document.body.textContent || '').trim().length
          const prev = w.__pmPrevLen
          w.__pmPrevLen = len
          return len >= 50 && prev !== undefined && Math.abs(len - prev) <= 2
        },
        undefined,
        { timeout: RENDER_TIMEOUT, polling: 400 },
      )
    } catch {
      /* never stabilised — assertions below still run on current DOM */
    }

    const title = await page.title()
    const body = (await page.locator('body').textContent()) || ''

    if (notFoundMarkers.some((m) => title.includes(m) || body.includes(m))) {
      failures.push(`${routePath}: rendered the not-found page`)
      continue
    }

    if (mustContain?.length) {
      // Wait for the required content to appear (auto-retries) instead of
      // reading once — slow render must not look like missing content.
      const needles = mustContain.map((n) => n.toLowerCase())
      try {
        await page.waitForFunction(
          (ns) => {
            const t = (document.body.textContent || '').toLowerCase()
            return ns.every((n) => t.includes(n))
          },
          needles,
          { timeout: RENDER_TIMEOUT },
        )
      } catch {
        // Timed out — report exactly which needles are still missing.
        const text = ((await page.locator('body').textContent()) || '').toLowerCase()
        for (const needle of mustContain) {
          if (!text.includes(needle.toLowerCase())) {
            failures.push(`${routePath}: missing expected content "${needle}"`)
          }
        }
      }
    }
  }

  return failures
}
