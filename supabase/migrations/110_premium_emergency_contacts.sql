-- =============================================================================
-- Migration 110 — Premium Emergency Contacts: schema + RLS + audit log +
-- reveal RPC (Module 10, spec §4.10)
-- =============================================================================
-- Overlay:      bcc-premium-overlay v0.5.3
-- Ships:        Module 10 (Emergency Contacts) end-to-end in one migration.
--
-- Depends on Base + overlay prerequisites (identical to 108 / 112):
--   • public.staff — Base 001 + 100a extensions + 100_shim full_name
--   • public.settings — Base shape (agency_id, setting_key, setting_value)
--   • public._install_provenance — 100_shim widened event_type/event_data
--   • public.get_current_role_is_owner() — 100_shim wrapper
--   • public.current_staff_id() — 100e shim
--
-- Spec §4.10 promise:
--   "Employee emergency contact management. One click to reach the right
--    person when something happens."
--
-- Design decisions:
--
--   1. Tight access model — this is the OPPOSITE of Milestones' public-
--      recognition surface. Emergency contacts contain EMPLOYEE FAMILY PII
--      (spouse/child/parent names and phone numbers). Direct SELECT by
--      owner or manager is BLOCKED at the RLS layer. Reveal happens ONLY
--      through rpc_reveal_emergency_contacts, which:
--        (a) requires a written reason (min 5 chars) — no reason, no reveal;
--        (b) writes an audit row to emergency_contact_access_log BEFORE
--            returning contacts;
--        (c) returns the setof rows atomically.
--      The audit log is INSERT-ONLY at RLS (append-only ledger).
--
--   2. Manager gate default — CANONICAL B.11 FALSE. Managers do not see
--      family PII unless the owner explicitly toggles the setting on.
--      Even when the setting is TRUE, every reveal still goes through the
--      reason prompt + audit log.
--
--   3. Producer visibility — every producer sees + manages their OWN
--      contacts through standard table SELECT/INSERT/UPDATE/DELETE with
--      RLS scoped to staff_id = current_staff_id(). This does not go
--      through the reveal RPC.
--
--   4. No AskClaudeButton in the JSX module — by design, emergency
--      contact data must NEVER flow through Claude conversations. No
--      seed prompts registered in Base's PlaybookGuide.jsx for this
--      module. Documented in spec §4.10 and JSX file header.
--
--   5. Storage — one row per (staff_id, priority) is NOT enforced. A
--      producer can have multiple contacts at the same priority; the
--      priority field is just an ordering hint. Total contacts per
--      producer is soft-capped at 10 (application-level warning, not a
--      DB constraint).
--
--   6. Idempotency — every DDL uses IF NOT EXISTS / OR REPLACE.
-- =============================================================================

BEGIN;

-- ============================================================================
-- 1. emergency_contacts — producer's own contacts
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.emergency_contacts (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id             uuid          NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,

  contact_name         text          NOT NULL,
  relationship         text          NOT NULL
                                     CHECK (relationship IN ('spouse','parent','sibling','friend','child','other')),

  phone_primary        text          NOT NULL,
  phone_secondary      text,
  email                text,

  priority             integer       NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 5),
  notes                text,

  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_emergency_contacts_staff
  ON public.emergency_contacts(staff_id, priority);

COMMENT ON TABLE public.emergency_contacts IS
  'Employee-owned emergency contact records. Contains employee family PII (not customer PII). Direct SELECT is producer-scoped via RLS. Owner/manager access goes exclusively through rpc_reveal_emergency_contacts, which requires a written reason and writes to emergency_contact_access_log. Producer manages own via standard supabase.from() DML.';

-- ============================================================================
-- 2. emergency_contact_access_log — append-only reveal audit ledger
-- ============================================================================
-- Every reveal by an owner or manager writes one row here BEFORE the
-- contacts are returned. INSERT-only at RLS (no UPDATE / DELETE
-- policies) so historical revelations cannot be rewritten. Owner-only
-- SELECT so producers cannot see who has looked at their contacts.

CREATE TABLE IF NOT EXISTS public.emergency_contact_access_log (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  accessed_staff_id    uuid          NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  accessed_by_auth_id  uuid          NOT NULL,  -- auth.users.id of caller (no FK — auth schema separate)
  accessed_by_name     text,                    -- Denormalized display name at time of access
  access_role          text          NOT NULL
                                     CHECK (access_role IN ('owner','manager','system')),
  reason               text          NOT NULL CHECK (length(trim(reason)) >= 5),
  accessed_at          timestamptz   NOT NULL DEFAULT now(),
  contact_count        integer       NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ec_access_log_staff
  ON public.emergency_contact_access_log(accessed_staff_id, accessed_at DESC);

CREATE INDEX IF NOT EXISTS idx_ec_access_log_when
  ON public.emergency_contact_access_log(accessed_at DESC);

COMMENT ON TABLE public.emergency_contact_access_log IS
  'Append-only audit ledger for emergency contact reveals. One row per rpc_reveal_emergency_contacts call. INSERT-only at RLS; historical rows cannot be rewritten. Owner-only SELECT visibility. Producers do not see who has viewed their contacts (that would create a chilling effect on providing accurate contact info).';

-- ============================================================================
-- 3. is_emergency_contacts_manager() — manager gate (canonical B.11 FALSE)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_emergency_contacts_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT
    EXISTS (
      SELECT 1
        FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
         AND s.role = 'Office Manager'
         AND s.status = 'active'
    )
    AND COALESCE(
      (SELECT lower(setting_value) = 'true'
         FROM public.settings
        WHERE setting_key = 'enable_emergency_contacts_manager_access'
        LIMIT 1),
      false  -- Canonical B.11 FALSE default. PII surface — owner opts managers in explicitly.
    );
$fn$;

REVOKE ALL ON FUNCTION public.is_emergency_contacts_manager() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_emergency_contacts_manager() TO authenticated;

COMMENT ON FUNCTION public.is_emergency_contacts_manager() IS
  'B.11 manager gate for Emergency Contacts. Returns true only when (a) caller holds active manager/office_manager role AND (b) enable_emergency_contacts_manager_access setting is true. Canonical B.11 FALSE default — this is family PII, opt-in only.';

-- ============================================================================
-- 4. Settings toggle — default FALSE (canonical B.11)
-- ============================================================================

INSERT INTO public.settings (agency_id, setting_key, setting_value, description)
SELECT
  a.id,
  'enable_emergency_contacts_manager_access',
  'false',
  'Producer Isolation Principle B.11 manager gate for Emergency Contacts module. When true, managers can call rpc_reveal_emergency_contacts (each call still requires a written reason and writes to the audit log). Canonical B.11 FALSE default — this module holds employee family PII. Owner opts managers in explicitly if desired.'
FROM public.agency a
ON CONFLICT (agency_id, setting_key) DO NOTHING;

-- ============================================================================
-- 5. RLS on emergency_contacts
-- ============================================================================
-- Producer-scoped by RLS. Owner and manager get NO direct SELECT — they
-- go through rpc_reveal_emergency_contacts (SECURITY DEFINER, audit-log
-- writing) exclusively.

ALTER TABLE public.emergency_contacts ENABLE ROW LEVEL SECURITY;

-- SELECT — producer sees own contacts only
DROP POLICY IF EXISTS emergency_contacts_read_own ON public.emergency_contacts;
CREATE POLICY emergency_contacts_read_own
  ON public.emergency_contacts
  FOR SELECT
  TO authenticated
  USING (staff_id = public.current_staff_id());

-- INSERT — producer inserts for self only
DROP POLICY IF EXISTS emergency_contacts_insert_own ON public.emergency_contacts;
CREATE POLICY emergency_contacts_insert_own
  ON public.emergency_contacts
  FOR INSERT
  TO authenticated
  WITH CHECK (staff_id = public.current_staff_id());

-- UPDATE — producer updates own
DROP POLICY IF EXISTS emergency_contacts_update_own ON public.emergency_contacts;
CREATE POLICY emergency_contacts_update_own
  ON public.emergency_contacts
  FOR UPDATE
  TO authenticated
  USING (staff_id = public.current_staff_id())
  WITH CHECK (staff_id = public.current_staff_id());

-- DELETE — producer deletes own
DROP POLICY IF EXISTS emergency_contacts_delete_own ON public.emergency_contacts;
CREATE POLICY emergency_contacts_delete_own
  ON public.emergency_contacts
  FOR DELETE
  TO authenticated
  USING (staff_id = public.current_staff_id());

-- ============================================================================
-- 6. RLS on emergency_contact_access_log
-- ============================================================================
-- INSERT-only for authenticated (RPC does the writing via SECURITY DEFINER,
-- but we leave a narrow authenticated policy too for future flexibility).
-- SELECT only for owner (producers should NOT see who viewed their contacts).

ALTER TABLE public.emergency_contact_access_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ec_access_log_read_owner_only ON public.emergency_contact_access_log;
CREATE POLICY ec_access_log_read_owner_only
  ON public.emergency_contact_access_log
  FOR SELECT
  TO authenticated
  USING (public.get_current_role_is_owner());

-- No INSERT / UPDATE / DELETE policies — SECURITY DEFINER RPC writes exclusively.
-- No UPDATE ever (append-only). No DELETE ever (audit trail).

-- ============================================================================
-- 7. rpc_reveal_emergency_contacts — audited reveal for owner / manager
-- ============================================================================
-- Requires a written reason (min 5 chars). Writes audit row BEFORE
-- returning contacts (fail-safe — if the log write throws, the caller
-- gets no data). Returns setof rows shaped like emergency_contacts plus
-- the accessed staff's display name for convenience.

DROP TYPE IF EXISTS public.emergency_contact_reveal_row CASCADE;
CREATE TYPE public.emergency_contact_reveal_row AS (
  id              uuid,
  staff_id        uuid,
  staff_name      text,
  contact_name    text,
  relationship    text,
  phone_primary   text,
  phone_secondary text,
  email           text,
  priority        integer,
  notes           text,
  updated_at      timestamptz
);

CREATE OR REPLACE FUNCTION public.rpc_reveal_emergency_contacts(
  p_staff_id uuid,
  p_reason   text
)
RETURNS SETOF public.emergency_contact_reveal_row
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_is_owner        boolean := public.get_current_role_is_owner();
  v_is_mgr          boolean := public.is_emergency_contacts_manager();
  v_role            text;
  v_reason_clean    text    := trim(coalesce(p_reason, ''));
  v_contact_count   integer;
  v_caller_name     text;
BEGIN
  -- Authorization — owner unconditionally, manager only with gate
  IF NOT (v_is_owner OR v_is_mgr) THEN
    RAISE EXCEPTION 'permission_denied: only owner or authorized manager can reveal emergency contacts'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Reason validation — mandatory, at least 5 non-whitespace chars
  IF length(v_reason_clean) < 5 THEN
    RAISE EXCEPTION 'reason_required: a written reason (at least 5 characters) is required to reveal emergency contacts'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Determine access role for audit log
  v_role := CASE WHEN v_is_owner THEN 'owner' ELSE 'manager' END;

  -- Capture caller's display name at time of access (for audit log durability)
  SELECT s.full_name
    INTO v_caller_name
    FROM public.staff s
   WHERE s.auth_user_id = auth.uid()
   LIMIT 1;

  -- Count contacts we're about to return (for audit log)
  SELECT count(*)
    INTO v_contact_count
    FROM public.emergency_contacts
   WHERE staff_id = p_staff_id;

  -- Write audit row FIRST (fail-safe — if this throws, no data returned)
  INSERT INTO public.emergency_contact_access_log
    (accessed_staff_id, accessed_by_auth_id, accessed_by_name,
     access_role, reason, contact_count)
  VALUES
    (p_staff_id, auth.uid(), v_caller_name, v_role,
     v_reason_clean, v_contact_count);

  -- Then return contacts
  RETURN QUERY
    SELECT
      ec.id,
      ec.staff_id,
      s.full_name AS staff_name,
      ec.contact_name,
      ec.relationship,
      ec.phone_primary,
      ec.phone_secondary,
      ec.email,
      ec.priority,
      ec.notes,
      ec.updated_at
    FROM public.emergency_contacts ec
    JOIN public.staff s ON s.id = ec.staff_id
   WHERE ec.staff_id = p_staff_id
   ORDER BY ec.priority, ec.contact_name;
END
$fn$;

REVOKE ALL ON FUNCTION public.rpc_reveal_emergency_contacts(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_reveal_emergency_contacts(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.rpc_reveal_emergency_contacts(uuid, text) IS
  'Audited reveal path for owner / manager access to a staff member''s emergency contacts. Requires a written reason (min 5 chars). Writes to emergency_contact_access_log BEFORE returning data (fail-safe). Owner: unconditional. Manager: only when is_emergency_contacts_manager()=true.';

-- ============================================================================
-- 8. Provenance
-- ============================================================================

INSERT INTO public._install_provenance (event_type, event_data)
VALUES (
  'overlay_migration_applied',
  jsonb_build_object(
    'migration',        '110_premium_emergency_contacts',
    'overlay_version',  '0.5.3',
    'ships_module',     'Module 10 — Emergency Contacts',
    'spec_ref',         '§4.10',
    'manager_gate_default', 'false (canonical B.11)',
    'ask_claude_prompts', 'none by design (PII surface)',
    'applied_at',       now()
  )
);

COMMIT;

-- =============================================================================
-- Verification (run manually after apply)
-- =============================================================================
--
-- 1. Tables + RLS enabled:
--    SELECT relname, relrowsecurity FROM pg_class
--     WHERE relname IN ('emergency_contacts','emergency_contact_access_log');
--    Expected: both rows show relrowsecurity = true.
--
-- 2. Settings toggle seeded as FALSE:
--    SELECT setting_key, setting_value FROM public.settings
--     WHERE setting_key = 'enable_emergency_contacts_manager_access';
--    Expected: setting_value = 'false'.
--
-- 3. Reveal RPC rejects short reason:
--    SELECT * FROM public.rpc_reveal_emergency_contacts(
--      (SELECT id FROM public.staff LIMIT 1), 'hi'
--    );
--    Expected: ERROR reason_required.
--
-- 4. Reveal RPC rejects when caller is not owner/manager (as a producer):
--    -- Simulate via a producer JWT context.
--    SELECT * FROM public.rpc_reveal_emergency_contacts(
--      (SELECT id FROM public.staff LIMIT 1), 'testing access'
--    );
--    Expected: ERROR permission_denied.
--
-- 5. Reveal RPC writes audit log when authorized:
--    -- As owner:
--    SELECT * FROM public.rpc_reveal_emergency_contacts(
--      (SELECT id FROM public.staff LIMIT 1), 'testing audit log'
--    );
--    SELECT count(*) FROM public.emergency_contact_access_log
--     WHERE reason = 'testing audit log';
--    Expected: 1.
--
-- 6. Access log SELECT restricted to owner:
--    -- As producer: SELECT * FROM public.emergency_contact_access_log; → 0 rows.
--    -- As owner:    SELECT * FROM public.emergency_contact_access_log; → N rows.
-- =============================================================================
