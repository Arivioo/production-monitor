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
 * POST to a function and report whether it is healthy. 401/403/400/422 without
 * auth/body are fine (the function booted and rejected us). 404 means not
 * deployed. Any 5xx means the function is DOWN — a crashed function, a dead
 * edge secret, or a BOOT_ERROR all surface as 5xx, and "reachable = not 404"
 * let every one of those pass for weeks (ReplyFlow post-reply 503 ×2 days,
 * ChannelMover SB_SECRET_KEY ×5 days — see
 * Audits/BREAKAGE_ROOT_CAUSE_INVESTIGATION_2026-07-14.md §8).
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
  return { slug, status: res.status, reachable: res.status !== 404 && res.status < 500 }
}
