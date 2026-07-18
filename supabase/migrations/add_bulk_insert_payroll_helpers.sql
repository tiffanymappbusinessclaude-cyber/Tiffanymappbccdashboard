-- Idempotency keys
CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_unique_per_check_date
  ON payroll_runs (agency_id, pay_date, source_document_id);

CREATE UNIQUE INDEX IF NOT EXISTS payroll_detail_unique_per_run_per_staff
  ON payroll_detail (payroll_run_id, staff_id);

-- Bulk insert for payroll_runs — accepts pre-generated UUIDs so caller can link payroll_detail
CREATE OR REPLACE FUNCTION public.bulk_insert_payroll_runs(rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_count int;
BEGIN
  INSERT INTO payroll_runs (
    id, agency_id, pay_period_start, pay_period_end, pay_date,
    payroll_provider, gross_payroll, employer_taxes, net_payroll, status, source_document_id, created_at
  )
  SELECT
    (r->>'id')::uuid,
    (r->>'agency_id')::uuid,
    (r->>'pay_period_start')::date,
    (r->>'pay_period_end')::date,
    (r->>'pay_date')::date,
    r->>'payroll_provider',
    (r->>'gross_payroll')::numeric,
    (r->>'employer_taxes')::numeric,
    (r->>'net_payroll')::numeric,
    COALESCE(r->>'status', 'historical'),
    (r->>'source_document_id')::uuid,
    NOW()
  FROM jsonb_array_elements(rows) r
  ON CONFLICT (agency_id, pay_date, source_document_id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- Bulk insert for payroll_detail
CREATE OR REPLACE FUNCTION public.bulk_insert_payroll_detail(rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_count int;
BEGIN
  INSERT INTO payroll_detail (
    id, payroll_run_id, agency_id, staff_id,
    gross_pay, federal_tax, state_tax, social_security, medicare, other_deductions, net_pay,
    employment_type, created_at
  )
  SELECT
    gen_random_uuid(),
    (r->>'payroll_run_id')::uuid,
    (r->>'agency_id')::uuid,
    NULLIF(r->>'staff_id','')::uuid,
    (r->>'gross_pay')::numeric,
    (r->>'federal_tax')::numeric,
    (r->>'state_tax')::numeric,
    (r->>'social_security')::numeric,
    (r->>'medicare')::numeric,
    (r->>'other_deductions')::numeric,
    (r->>'net_pay')::numeric,
    r->>'employment_type',
    NOW()
  FROM jsonb_array_elements(rows) r
  ON CONFLICT (payroll_run_id, staff_id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.bulk_insert_payroll_runs(jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bulk_insert_payroll_detail(jsonb) TO anon, authenticated, service_role;
