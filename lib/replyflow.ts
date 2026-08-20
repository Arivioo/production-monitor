import { createClient } from '@supabase/supabase-js'
import { resolveUserIdByEmail } from './auth'

/**
 * Seeds the ReplyFlow monitor user as a genuinely onboarded account.
 *
 * WHY this exists: ReplyFlow's OnboardingGate is a MANDATORY, non-dismissible
 * modal (`role="dialog" aria-modal` covering `inset-0`) for any user with no
 * business, or with a business whose reply_profiles row has no
 * onboarding_completed_at. It intercepts pointer events, so every click-based
 * interaction test (reviews tabs, analytics range buttons, sidebar nav) times
 * out with "…subtree intercepts pointer events".
 *
 * The monitor used to sidestep it with the client seam
 * `localStorage.rf_e2e_no_onboarding=1`. ReplyFlow deliberately compiled that
 * seam out of the PRODUCTION bundle in 4de26ba (2026-08-20, deployed 05:59Z) —
 * it also bypassed the card-required trial gate, so anyone could disable
 * paywalling from devtools. That hardening is correct and must stay; the
 * monitor's job is to establish its own precondition against the real schema
 * instead of relying on a test-only escape hatch that no longer ships.
 *
 * Writes are confined to the monitor user's own rows and are inert: the
 * seeded business has no platform_connection, and schedule-review-sync only
 * walks connections with status='connected', so nothing syncs or bills.
 */
export async function ensureOnboardedBusiness(
  supabaseUrl: string,
  serviceRoleKey: string,
  email: string,
  opts: { name?: string } = {},
): Promise<string> {
  const userId = await resolveUserIdByEmail(supabaseUrl, serviceRoleKey, email, 'ensureOnboardedBusiness')
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: existing, error: selErr } = await supabase
    .from('businesses')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (selErr) throw new Error(`ensureOnboardedBusiness select businesses failed: ${selErr.message}`)

  let businessId = existing?.[0]?.id as string | undefined
  if (!businessId) {
    const { data: inserted, error: insErr } = await supabase
      .from('businesses')
      .insert({
        user_id: userId,
        name: opts.name ?? 'Production Monitor Test Business',
        type: 'other',
        tone: 'professional',
      })
      .select('id')
      .single()
    if (insErr) throw new Error(`ensureOnboardedBusiness insert business failed: ${insErr.message}`)
    businessId = inserted!.id as string
  }

  // reply_profiles.business_id is UNIQUE, so onConflict keeps this idempotent.
  // onboarding_completed_at is what useOnboardingStatuses reads as `completed`;
  // onboarding_step is the resume position and must be past the last wizard step.
  const { error: upErr } = await supabase
    .from('reply_profiles')
    .upsert(
      {
        business_id: businessId,
        onboarding_completed_at: new Date().toISOString(),
        onboarding_step: 4,
      },
      { onConflict: 'business_id' },
    )
  if (upErr) throw new Error(`ensureOnboardedBusiness upsert reply_profiles failed: ${upErr.message}`)

  return businessId
}
