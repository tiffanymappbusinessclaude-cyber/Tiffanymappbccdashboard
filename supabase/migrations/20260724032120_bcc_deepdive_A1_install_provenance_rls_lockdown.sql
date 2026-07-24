-- bcc-deepdive/A1 — 2026-07-24T04:20Z
-- Finding F5: _install_provenance had RLS OFF and 0 policies. Advisor ERROR
-- (rls_disabled_in_public). Additive-only fix: enable RLS + service_role
-- SELECT policy so the install log stays readable to Postgres admin while
-- being invisible to anon/authenticated (it's an internal audit trail).
-- Rollback: DROP POLICY + ALTER TABLE ... DISABLE ROW LEVEL SECURITY.

ALTER TABLE public._install_provenance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "install_provenance_service_role_read"
  ON public._install_provenance
  AS PERMISSIVE
  FOR SELECT
  TO service_role
  USING (true);

COMMENT ON TABLE public._install_provenance IS
  'Internal install audit trail. RLS-locked to service_role only per deep-dive audit 2026-07-24T04:20Z (bcc-deepdive/A1). No user-facing reads.';
