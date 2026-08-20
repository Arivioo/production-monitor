/**
 * Edge-function reachability via auto-discovery.
 *
 * WHY: hardcoding the list of edge functions per project drifts the moment a
 * function is added or removed — a removed function left in the list produces a
 * permanent false 404 alarm (exactly what happened with ChannelMover's extension
 * retirement). Instead we ask Supabase what is ACTUALLY deployed and check each
 * one responds. Add/remove a function and the monitor follows automatically — no
 * spec edit, no drift.
 */

/** Extract the Supabase project ref from its URL (https://<ref>.supabase.co). */
export function projectRefFromUrl(supabaseUrl: string): string {
  const host = new URL(supabaseUrl).hostname
  const ref = host.split('.')[0]
  if (!ref) throw new Error(`Cannot derive project ref from ${supabaseUrl}`)
  return ref
}

/** List the slugs of every edge function currently deployed to a project. */
export async function listDeployedFunctions(
  projectRef: string,
  accessToken: string,
): Promise<string[]> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/functions`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) {
    throw new Error(
      `listDeployedFunctions(${projectRef}) failed: HTTP ${res.status} ${await res.text()}`,
    )
  }
  const data = (await res.json()) as Array<{ slug?: string }>
  if (!Array.isArray(data)) {
    throw new Error(`listDeployedFunctions(${projectRef}) returned non-array`)
  }
  return data.map((f) => f.slug).filter((s): s is string => Boolean(s))
}

/**
 * Supabase's platform answer when a slug has NO deployment at all. A booted
 * function that happens to answer 404 never produces this shape.
 * Verified live 2026-08-20: POST /functions/v1/nonexistent-fn-xyz ->
 * {"code":"NOT_FOUND","message":"Requested function was not found"}
 */
function isPlatformNotFound(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown }
    if (parsed?.code === 'NOT_FOUND') return true
  } catch {
    // not JSON — cannot be the platform shape
  }
  return /Requested function was not found/i.test(body)
}

/**
 * POST to a function and report whether it is healthy. 401/403/400/422 without
 * auth/body are fine (the function booted and rejected us). Any 5xx means the
 * function is DOWN — a crashed function, a dead edge secret, or a BOOT_ERROR all
 * surface as 5xx, and "reachable = not 404" let every one of those pass for weeks
 * (ReplyFlow post-reply 503 x2 days, ChannelMover SB_SECRET_KEY x5 days — see
 * Audits/BREAKAGE_ROOT_CAUSE_INVESTIGATION_2026-07-14.md section 8).
 *
 * A bare 404 is AMBIGUOUS and must not be failed on its own: functions that route
 * on a query param or path segment answer our empty probe with their OWN 404
 * (BackOffice client-project-steps + client-open-items resolve ?p=<slug> and
 * return {"error":"Not found"} for the empty probe — both fully deployed and
 * healthy, yet they reddened the monitor on 2026-08-20). Only the platform's
 * NOT_FOUND body proves a function is missing, so that is what we key on.
 */
export async function isFunctionReachable(
  supabaseUrl: string,
  slug: string,
): Promise<{ slug: string; status: number; reachable: boolean }> {
  const res = await fetch(`${supabaseUrl}/functions/v1/${slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const status = res.status
  if (status >= 500) return { slug, status, reachable: false }
  if (status !== 404) return { slug, status, reachable: true }

  const body = await res.text().catch(() => '')
  return { slug, status, reachable: !isPlatformNotFound(body) }
}
