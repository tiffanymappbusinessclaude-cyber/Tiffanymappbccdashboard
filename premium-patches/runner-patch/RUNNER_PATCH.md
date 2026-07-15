# RUNNER_PATCH.md

**How Setup Claude patches Base's `automation-runner/index.ts` to add the Premium auth provisioner orchestrator.**

This is a prescriptive patch spec, following the same pattern as `nav-patch/NAV_ITEMS.premium.js`. Setup Claude reads the client's current `supabase/functions/automation-runner/index.ts`, plans the two edits, applies them, verifies, and redeploys the function.

---

## What ships in this directory

- `auth_provisioner.ts` — a self-contained TypeScript orchestrator function (`runAuthProvisioner`) plus two module-scope helper functions (`inviteOrLookup`, `putUserBan`). Zero imports beyond what Base's runner already provides.
- `RUNNER_PATCH.md` — this file.

Both files ship as part of `bcc-premium-overlay`. Neither is copied into the client repo verbatim; the TypeScript is spliced into the client's runner via the two edits below.

---

## Prerequisites

Before applying this patch:

1. Base runner is at least v3 (has the B8b two-stage orchestrator section — check for the comment block starting `// B8b — Two-stage orchestrators for internal_handler recipes` around line 360 of `index.ts`). Base migration 030 must also be applied.
2. Migration `100b_auth_provisioner_helpers.sql` has been applied to the client's Supabase project. Verify via:
   ```sql
   SELECT proname FROM pg_proc WHERE proname IN (
     'fn_claim_next_auth_action',
     'fn_mark_auth_action_success',
     'fn_mark_auth_action_failure'
   );
   -- Should return three rows.
   ```
3. Migration `100a_premium_auto_provisioning.sql` is applied (queue table + trigger).

If any prerequisite is missing, stop. The patch will land but the runner will error at runtime.

---

## The patch — two edits

### Edit 1: Add the orchestrator + helpers as module-scope functions

**Where:** Base's `automation-runner/index.ts`, at the end of the "B8b — Two-stage orchestrators" section. Currently the section ends with `runInstagramManualReminder` around line ~2900. Insert the new function block immediately after it, **before** the closing of that logical section (before the main serve/handler code around line ~2950).

Any location in the file works technically — Deno hoists function declarations — but keeping it in the B8b block preserves readability. The B8b comment block explicitly lists the handlers; add the new one to that comment as well:

```ts
// Handlers implemented here:
//   dispatch_email_archiver               -> runEmailArchiver
//   dispatch_document_processor           -> runDocumentProcessor
//   dispatch_document_processor_backfill  -> runDocumentProcessorBackfill
//   instagram_manual_reminder             -> runInstagramManualReminder
//   dispatch_premium_auth_provisioner     -> runAuthProvisioner   ← ADD THIS LINE
```

**Content to insert:** the entire contents of `auth_provisioner.ts` (this directory), starting from the leading `// =====` header block through the closing `}` of `putUserBan`. Do not strip the header comments — the design rationale, state machine, and test plan belong with the code.

### Edit 2: Register the dispatch case

**Where:** Base's `automation-runner/index.ts`, around line 3016 in the INTERNAL branch. Find the chain of `else if (handler === "...")` lines. The current chain looks like:

```ts
if (handler === "dispatch_email_archiver") {
  orchestratorResult = await runEmailArchiver(recipe);
} else if (handler === "dispatch_document_processor") {
  orchestratorResult = await runDocumentProcessor(recipe);
} else if (handler === "dispatch_document_processor_backfill") {
  orchestratorResult = await runDocumentProcessorBackfill(recipe);
} else if (handler === "instagram_manual_reminder") {
  orchestratorResult = await runInstagramManualReminder(recipe);
}
```

**Add one more branch at the end of the chain, before the closing `}`:**

```ts
} else if (handler === "dispatch_premium_auth_provisioner") {
  orchestratorResult = await runAuthProvisioner(recipe);
}
```

Order matters for readability but not for correctness — each branch is independent. Keep the chain alphabetical if you're keeping it alphabetical, or append at the end if the convention is chronological.

---

## Verification after patch

1. **Type-check the runner locally:**
   ```bash
   cd <client-repo>/supabase/functions
   deno check automation-runner/index.ts
   ```
   No errors expected. If TypeScript complains about `any` or `unknown` types, check that the `sb`, `SUPABASE_URL`, and `SERVICE_ROLE_KEY` module-scope constants are present at the top of `index.ts` (they should be — they're from Base).

2. **Deploy the function to the client's Supabase:**
   ```bash
   supabase functions deploy automation-runner
   ```

3. **Smoke test the orchestrator with an empty queue:**
   ```sql
   -- No pending actions expected initially. Trigger a manual run:
   SELECT run_automation_recipe(
     (SELECT id FROM automation_recipes
      WHERE recipe_name = 'Premium Auth Provisioner'
        AND agency_id = '<agency_id>')
   );
   -- Verify in automation_run_log:
   SELECT status, output_summary FROM automation_run_log
   WHERE recipe_id = (SELECT id FROM automation_recipes WHERE recipe_name = 'Premium Auth Provisioner')
   ORDER BY run_at DESC LIMIT 1;
   -- Expected: status='success', output_summary='no pending actions'
   ```

4. **Smoke test with a real action:** insert a test staff row and watch the queue drain within one minute:
   ```sql
   INSERT INTO staff (first_name, last_name, email, status)
   VALUES ('Test', 'Provisioner', 'test-provisioner@example.com', 'active');
   -- Wait 60s, then:
   SELECT auth_user_id FROM staff WHERE email = 'test-provisioner@example.com';
   -- Expected: non-null uuid.
   SELECT processed_by, process_result FROM _pending_auth_actions
   WHERE staff_email = 'test-provisioner@example.com';
   -- Expected: processed_by='premium_auth_provisioner', process_result.success=true.
   ```

5. **Clean up test row:**
   ```sql
   DELETE FROM _pending_auth_actions
   WHERE staff_id = (SELECT id FROM staff WHERE email='test-provisioner@example.com');
   DELETE FROM staff WHERE email = 'test-provisioner@example.com';
   -- Also delete the auth user if desired via Supabase Dashboard > Authentication.
   ```

---

## Rollback

If the patch causes issues, revert `index.ts` to its pre-patch state (git checkout) and redeploy. The recipe row in `automation_recipes` can stay — with the orchestrator missing, the recipe will fail with `handler === "dispatch_premium_auth_provisioner"` matching nothing, falling through to the pure-SQL path which will also fail (no such Postgres function). Errors surface in `automation_run_log`, no data corruption. To fully back out, also `DELETE FROM automation_recipes WHERE recipe_name = 'Premium Auth Provisioner' AND agency_id = '<agency_id>'`.
