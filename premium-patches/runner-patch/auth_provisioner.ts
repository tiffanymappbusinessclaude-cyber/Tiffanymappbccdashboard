// =============================================================================
// runAuthProvisioner  —  Premium §100 auto-provisioning orchestrator
// =============================================================================
// Overlay:      bcc-premium-overlay v0.5.1-rc1
// Injected by:  runner-patch/RUNNER_PATCH.md instructions during overlay apply
// Injected into: supabase/functions/automation-runner/index.ts (Base repo)
// Handler slug: dispatch_premium_auth_provisioner
//
// Purpose
// -------
// Drains one row per tick from _pending_auth_actions. Provisions, revokes,
// or restores Supabase Auth accounts for staff based on the staff.status
// transitions written by migration 100a's trigger. Prerequisite for the
// Auto-Provisioning Invariant (design doc §B.12) to actually function.
//
// Fits into the B8b two-stage orchestrator pattern that already houses
// runEmailArchiver, runDocumentProcessor, runInstagramManualReminder.
// Two-stage bookends:
//    prepare  = fn_claim_next_auth_action     (migration 100b, atomic claim)
//    execute  = HTTP calls to Supabase Auth admin API (this function)
//    log      = fn_mark_auth_action_success   (migration 100b, transactional)
//               fn_mark_auth_action_failure   (migration 100b, retry accounting)
//
// The runner's outer wrapper (index.ts line ~2999) handles automation_run_log
// insertion and recipe.last_run_status updates — this function only returns
// { recordsProcessed, outputSummary }.
//
// State machine (single tick)
// ---------------------------
//   1. CLAIM      -> fn_claim_next_auth_action(max_retries, backoff_seconds)
//                    Returns 0 rows if queue empty or in backoff -> return early
//   2. DISPATCH   -> switch on action_type:
//                    'provision' -> POST /auth/v1/invite
//                                   On 422 "already registered" -> GET /admin/users?email=
//                    'revoke'    -> if existing_auth_user_id: PUT /admin/users/{id} ban_duration=876000h
//                                   else: noop success
//                    'restore'   -> if existing_auth_user_id: PUT /admin/users/{id} ban_duration=none
//                                   else: fall through to fresh invite (auth acct manually deleted)
//   3. MARK       -> fn_mark_auth_action_success(action_id, auth_user_id, summary)
//                    or fn_mark_auth_action_failure(action_id, error, max_retries)
//
// Idempotency
// -----------
// The 422 "already registered" fallback is the critical safety property.
// If a prior tick invited the user successfully but crashed before marking
// the queue row done, the next tick's invite will return 422 - we fetch
// the existing user id and complete the queue mark. No data corruption.
//
// Producer Isolation (B.11)
// -------------------------
// All three helpers (fn_claim, fn_mark_success, fn_mark_failure) are
// SECURITY DEFINER + service_role-only. The runner already has
// SUPABASE_SERVICE_ROLE_KEY so RPC calls succeed transparently.
//
// Config schema (recipe.input_config)
// -----------------------------------
// {
//   "max_retries": 5,           // permanent failure after this many failed attempts
//   "backoff_seconds": 300,     // soft-lock window between retries
//   "ban_duration_on_revoke": "876000h",  // ~100 years; effectively permanent
//   "required_settings": []     // no Composio credentials needed
// }
//
// Environment variables (already in index.ts)
// -------------------------------------------
//   SUPABASE_URL              — module-level const
//   SUPABASE_SERVICE_ROLE_KEY — module-level const (aliased as SERVICE_ROLE_KEY)
//   sb                        — module-level Supabase client using service_role
//
// Return contract
// ---------------
//   { recordsProcessed: 0, outputSummary: "no pending actions" }
//                            when queue empty (normal 99% of ticks)
//   { recordsProcessed: 1, outputSummary: "provision for x@y: provisioned" }
//                            when one action processed successfully
//   throws                    when the CLAIM RPC itself fails
//                            (permanent-fail for individual actions does NOT
//                             throw — it's captured via fn_mark_auth_action_failure
//                             so the queue row stops being retried)
//
// Test plan (against a local Supabase project)
// --------------------------------------------
//   Provision happy: INSERT INTO staff (first_name, last_name, email, status)
//                     VALUES ('Test', 'User', 'test-user@example.com', 'active');
//                    -> within 60s, invite email received, staff.auth_user_id populated
//   Revoke:          UPDATE staff SET status='terminated' WHERE email='test-user@example.com';
//                    -> auth user banned, staff.auth_user_id retained (audit)
//   Restore:         UPDATE staff SET status='active' WHERE email='test-user@example.com';
//                    -> auth user unbanned
//   Idempotency:     Manually invite the user via Auth API, then create staff row with
//                    same email + status='active' -> 422 fallback fetches existing id
//   Failure:         Set staff.email to an invalid value -> retries 5 times over 25 min
//                    -> permanent failure with processed_by=@max_retries_exceeded
// =============================================================================

async function runAuthProvisioner(recipe: any): Promise<{
  recordsProcessed: number;
  outputSummary: string;
}> {
  const config = (recipe.input_config ?? {}) as Record<string, unknown>;
  const maxRetries = Number(config.max_retries ?? 5);
  const backoffSeconds = Number(config.backoff_seconds ?? 300);
  const banDuration = String(config.ban_duration_on_revoke ?? "876000h");

  // ---------------------------------------------------------------------------
  // Stage 1: Claim
  // ---------------------------------------------------------------------------
  const { data: claimData, error: claimErr } = await sb.rpc(
    "fn_claim_next_auth_action",
    { p_max_retries: maxRetries, p_backoff_seconds: backoffSeconds },
  );
  if (claimErr) {
    throw new Error(`fn_claim_next_auth_action failed: ${claimErr.message}`);
  }
  const rows = (claimData ?? []) as Array<{
    action_id: string;
    action_type: "provision" | "revoke" | "restore";
    staff_id: string;
    staff_email: string;
    staff_name: string;
    existing_auth_user_id: string | null;
    retry_count: number;
  }>;
  if (rows.length === 0) {
    return { recordsProcessed: 0, outputSummary: "no pending actions" };
  }
  const action = rows[0];

  // ---------------------------------------------------------------------------
  // Stage 2: Dispatch
  // ---------------------------------------------------------------------------
  let authUserIdForStaffUpdate: string | null = null;
  let summary = "";
  let dispatchError: string | null = null;

  try {
    if (action.action_type === "provision") {
      const result = await inviteOrLookup(action.staff_email, action.staff_id, action.staff_name);
      authUserIdForStaffUpdate = result.userId;
      summary = result.viaFallback ? "provisioned-via-lookup" : "provisioned";

    } else if (action.action_type === "revoke") {
      if (action.existing_auth_user_id) {
        await putUserBan(action.existing_auth_user_id, banDuration);
        summary = "revoked";
      } else {
        summary = "revoke-noop-never-provisioned";
      }
      // authUserIdForStaffUpdate stays null: fn_mark_auth_action_success
      // deliberately does not touch staff.auth_user_id on revoke.

    } else if (action.action_type === "restore") {
      if (action.existing_auth_user_id) {
        await putUserBan(action.existing_auth_user_id, "none");
        authUserIdForStaffUpdate = action.existing_auth_user_id;
        summary = "restored";
      } else {
        // Edge case: auth account was manually deleted between termination
        // and rehire. Fall through to fresh invite.
        const result = await inviteOrLookup(action.staff_email, action.staff_id, action.staff_name);
        authUserIdForStaffUpdate = result.userId;
        summary = "restored-via-fresh-invite";
      }

    } else {
      // Unreachable if 100a's CHECK constraint holds, but defensive.
      throw new Error(`unknown action_type: ${action.action_type}`);
    }
  } catch (e) {
    dispatchError = e instanceof Error ? e.message : String(e);
  }

  // ---------------------------------------------------------------------------
  // Stage 3: Mark result
  // ---------------------------------------------------------------------------
  if (dispatchError) {
    const { data: failResult, error: markErr } = await sb.rpc(
      "fn_mark_auth_action_failure",
      {
        p_action_id: action.action_id,
        p_error: dispatchError,
        p_max_retries: maxRetries,
      },
    );
    if (markErr) {
      // If we can't even record the failure, something is very wrong.
      // Throwing here surfaces to automation_run_log with the outer error.
      throw new Error(
        `dispatch failed and fn_mark_auth_action_failure also failed. ` +
          `dispatch: ${dispatchError}; mark: ${markErr.message}`,
      );
    }
    const attempt = (failResult?.retry_count as number) ?? action.retry_count + 1;
    const exhausted = (failResult?.exhausted as boolean) ?? false;
    return {
      recordsProcessed: 0,
      outputSummary:
        `${action.action_type} for ${action.staff_email} failed ` +
        `(attempt ${attempt}${exhausted ? ", exhausted" : ""}): ${dispatchError}`,
    };
  }

  const { error: markErr } = await sb.rpc("fn_mark_auth_action_success", {
    p_action_id: action.action_id,
    p_auth_user_id: authUserIdForStaffUpdate,
    p_summary: summary,
  });
  if (markErr) {
    // Success at auth API but failed to mark the queue row done. Next tick
    // will attempt the same action again; the 422 idempotency fallback
    // catches the duplicate invite case for provision, and revoke/restore
    // are already idempotent server-side.
    throw new Error(
      `${action.action_type} succeeded at auth layer but fn_mark_auth_action_success failed: ${markErr.message}`,
    );
  }

  return {
    recordsProcessed: 1,
    outputSummary: `${action.action_type} for ${action.staff_email}: ${summary}`,
  };
}

// -----------------------------------------------------------------------------
// Helper: invite user with idempotency fallback on "already registered"
// -----------------------------------------------------------------------------
async function inviteOrLookup(
  email: string,
  staffId: string,
  staffName: string,
): Promise<{ userId: string; viaFallback: boolean }> {
  const inviteRes = await fetch(`${SUPABASE_URL}/auth/v1/invite`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      data: { staff_id: staffId, staff_name: staffName },
    }),
  });
  const inviteBody = await inviteRes.json().catch(() => ({}));

  if (inviteRes.ok) {
    // Supabase Auth response shape has varied by version. Accept either
    // top-level id or nested user.id.
    const userId = (inviteBody as any)?.id ?? (inviteBody as any)?.user?.id;
    if (!userId) {
      throw new Error(
        `invite returned ok but no user id: ${JSON.stringify(inviteBody)}`,
      );
    }
    return { userId, viaFallback: false };
  }

  // Idempotency path: 422 with "already registered" -> fetch existing user id
  const bodyStr = JSON.stringify(inviteBody).toLowerCase();
  if (inviteRes.status === 422 && bodyStr.includes("already registered")) {
    const lookupUrl = new URL(`${SUPABASE_URL}/auth/v1/admin/users`);
    lookupUrl.searchParams.set("email", email);
    const lookupRes = await fetch(lookupUrl.toString(), {
      method: "GET",
      headers: {
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      },
    });
    const lookupBody = await lookupRes.json().catch(() => ({}));
    if (!lookupRes.ok) {
      throw new Error(
        `lookup after 422 failed status=${lookupRes.status}: ${JSON.stringify(lookupBody)}`,
      );
    }
    const users = (lookupBody as any)?.users ?? [];
    const userId = users[0]?.id;
    if (!userId) {
      throw new Error(
        `lookup returned no user for email=${email}: ${JSON.stringify(lookupBody)}`,
      );
    }
    return { userId, viaFallback: true };
  }

  throw new Error(
    `invite failed status=${inviteRes.status}: ${JSON.stringify(inviteBody)}`,
  );
}

// -----------------------------------------------------------------------------
// Helper: set or clear ban on an existing auth user
//   duration = "876000h"  -> effectively permanent lock
//   duration = "none"     -> lift the ban
// -----------------------------------------------------------------------------
async function putUserBan(userId: string, duration: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: {
      "apikey": SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ban_duration: duration }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `PUT /admin/users/${userId} ban_duration=${duration} failed status=${res.status}: ${JSON.stringify(body)}`,
    );
  }
}
