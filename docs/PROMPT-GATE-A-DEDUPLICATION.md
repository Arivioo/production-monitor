Merge the six hand-copied Gate A crawlers into one shared engine.

WHY (all measured 2026-08-20; re-verify before trusting any of it):
The Gate A crawler - the robot that walks each product's staging site, opens every
dialog, and checks each one is usable - exists as SIX hand-copied files:

  replyflow/e2e/staging/gate-a-crawl.spec.ts       669 lines
  Valrano/e2e/staging/gate-a-crawl.spec.ts         593
  signalscore/e2e/staging/gate-a-crawl.spec.ts     581
  BoatBuddy/e2e/staging/gate-a-crawl.spec.ts       550
  ChannelMover/e2e/staging/gate-a-crawl.spec.ts    545
  BackOffice/e2e/staging/gate-a-crawl.spec.ts      563

They are not merely similar. `diff` with line endings normalised (tr -d '\r'):
488 of Valrano's 593 lines are character-for-character identical to signalscore's
(82%). Pairwise overlap across the fleet measured 50% to 82%.

THE COST, which is not hypothetical. On 2026-08-20 alone:
  - `if: always()` -> `!cancelled()` was fixed THREE times (BackOffice 73d96a0,
    Valrano 6e5a243, signalscore 8f9d287).
  - "blocked routes never asserted" was fixed FIVE times, the last being
    BackOffice f5af770, which until then silently passed over a reduced
    denominator while the other five already had the fix.
  - The NEWEST rule (measured-vs-unmeasured, replyflow e0718da) exists in only
    2 of 6 copies. The other four will each go permanently red the first time
    they meet a by-design undismissable modal, exactly as ReplyFlow did.

GOAL: a fix lands ONCE and all six products get it.

WHERE IT SHOULD LIVE - there is NO existing mechanism, do not assume one.
`C:\Business\Templates\e2e\critical-path.spec.ts` LOOKS like a precedent. It is
not. Measured 2026-08-20: only 36-38 of its 254 lines are identical to the repo
copies (14%), NO repo references the Templates directory, no script in
`Templates\scripts\` syncs it, and the file is dated May 29. It is a stale
snapshot nobody consumes. Do not wire the Gate A engine into it assuming it works.

So choosing the mechanism is part of THIS task. Read
`C:\Business\Templates\CANONICAL_SOURCES.md` first (the registry of what is
canonical and where), then pick ONE of:
  (a) a real shared package the repos depend on - strongest guarantee, most setup;
  (b) one canonical file plus a sync script AND a CI check that fails when a repo
      copy has drifted - less work, but the drift check is mandatory;
  (c) something better you can justify.
State the choice, the reason, and the failure mode you accept BEFORE converting
any product. A shared file with no drift detection is barely better than six
copies, because it rots the same way - which is exactly what happened to
critical-path.spec.ts.

THE SEAM (from reading replyflow's copy; verify per product):
  GENERIC, belongs in the shared engine - the crawl loop, dialog fingerprinting,
    measure() / scrollerAncestor() / commitControl() / assertReachable(), the
    measured-vs-unmeasured partition, the summary block, all assertions, the
    manifest write.
  PRODUCT-SPECIFIC, stays in each repo - STAGING_URL, REF, ANON, IDENTITIES,
    ROUTES, HARD_DENY / PURCHASE_DENY / ALLOW_OPENERS / COMMIT regexes,
    VIEWPORTS, CONTROLS, NO_OP_ROUTES.
  Take the CURRENT replyflow copy as the reference implementation: it has the
    newest rules. Do NOT merge to the lowest common denominator.

HARD CONSTRAINTS:
- These six gates are live CI. Breaking one is worse than the duplication.
  Do ONE product at a time, push, and confirm THAT product's staging-gates run is
  green before starting the next. Never convert all six then push.
- Do NOT weaken any assertion to make a product pass. If a product genuinely needs
  different behaviour that is a parameter, not a removed check. Say so explicitly.
- Do NOT touch product code. e2e specs and workflow files only.
- NEVER `git add -A` or `git add .`; stage explicit paths. Other sessions work in
  these repos.
- No em-dash characters (U+2014) anywhere. Use " - ".
- Spec/test-class changes may push to main (auto-deploys STAGING). No prod
  promotion; that is Roger's manual call.

KNOWN PRE-EXISTING RED, do not mistake it for your own breakage:
BackOffice staging-gates was already failing before this work, in the "Run v11
hardened gates" step (a toBeGreaterThanOrEqual assertion receiving 1, the coverage
denominator class), NOT in the Gate A crawl step. Judge your change by the CRAWL
step's result and say clearly which step you are reporting on.

ACCEPTANCE (this is the receipt, not a screenshot):
1. All six products' staging-gates CRAWL step green after conversion, each run URL
   listed. Note separately any pre-existing failure in another step.
2. Prove the point: make ONE change in the shared engine (a comment is enough) and
   show it reaching all six products without editing six files.
3. Report how many lines of duplication were removed, measured the same way it was
   measured here (diff with line endings normalised).

IF THE SEAM IS NOT CLEAN - for example a product's crawl genuinely diverges rather
than merely drifting - STOP and report that with evidence rather than forcing a
merge. A wrong abstraction across six live CI gates is worse than six honest copies.
