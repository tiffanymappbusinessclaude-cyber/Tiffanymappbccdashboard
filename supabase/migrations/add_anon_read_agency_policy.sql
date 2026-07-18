-- The agency table had RLS enabled but zero policies, blocking anon reads.
-- That caused BCCApp.jsx + Dashboard.jsx to fall back to MOCK_AGENCY = "Smith Insurance Agency" / "Jane Smith".
-- Mirror the pattern used on every other web-facing table.
CREATE POLICY anon_read_agency ON public.agency
  FOR SELECT TO anon
  USING (true);
