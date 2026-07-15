// =============================================================================
// useMyProfile.js — React hook returning the caller's staff row
// -----------------------------------------------------------------------------
// Overlay: bcc-premium-overlay v0.5.4 (added 2026-07-11 during v0.5.4 UI-layer
// housekeeping — extracted from local copies previously inlined in Handbook.jsx
// and Benefits.jsx to DRY up the pattern).
//
// Purpose: overlay modules that need the caller's agency_id (for RPCs that take
// p_agency_id, or for guarding admin surfaces by role) call this hook once at
// mount. Returns { data, loading, error }:
//   - data: { id, role, agency_id, full_name, status } | null
//   - loading: true while the auth+staff lookup is in flight
//   - error: any Error from Supabase auth or the staff select
//
// The hook is deliberately narrow — it only reads a small set of columns from
// public.staff. Modules that need more fields should extend the select() call
// in a local helper rather than expanding this shared hook.
//
// Attribution: the underlying data (staff.auth_user_id, staff.status,
// staff.full_name) all come from overlay 100/100a (100_base_compat_shim adds
// full_name as GENERATED; 100a adds auth_user_id + status). Base itself ships
// only first_name + last_name + is_active.
//
// Future consolidation: if Base ever ships a shared useMyProfile in
// webapp-modules/src/lib/hooks.js, this file can be deleted and callers
// updated to import from there instead.
// =============================================================================

import { useState, useEffect } from "react";
import { supabase } from "./supabase.js";

export function useMyProfile() {
  const [state, setState] = useState({ data: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // Prefer getSession() over getUser() here: in @supabase/supabase-js v2
        // getUser() *throws* AuthSessionMissingError when there is no session,
        // which was collapsing the "no auth = demo mode" branch into the outer
        // catch. getSession() returns { session: null } cleanly instead.
        const { data: { session } } = await supabase.auth.getSession();
        const user = session?.user ?? null;

        // Demo / no-auth fallback: if there's no signed-in user, resolve the
        // agent-owner as the caller identity. This keeps modules that gate on
        // "who am I?" (TimeTracking, SalesActivity, etc.) working in demo mode
        // where the Vercel deploy hits Supabase with the anon key only.
        if (!user) {
          const { data: ownerRow, error: ownerErr } = await supabase
            .from("staff")
            .select("id, role, agency_id, full_name, status")
            .eq("role", "Owner / Agent")
            .eq("status", "active")
            .limit(1)
            .maybeSingle();
          if (ownerErr) throw ownerErr;
          if (!cancelled) setState({ data: ownerRow ?? null, loading: false, error: null });
          return;
        }

        const { data, error } = await supabase
          .from("staff")
          .select("id, role, agency_id, full_name, status")
          .eq("auth_user_id", user.id)
          .maybeSingle();

        if (error) throw error;
        if (!cancelled) setState({ data, loading: false, error: null });
      } catch (err) {
        if (!cancelled) setState({ data: null, loading: false, error: err });
      }
    })();

    return () => { cancelled = true; };
  }, []);

  return state;
}

export default useMyProfile;
