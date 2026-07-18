-- Mirrors bulk_insert_credit_transactions / bulk_insert_comp_recap pattern.
-- Idempotent insert into bank_transactions via JSONB array.
-- Unique key: (agency_id, bank_account_id, transaction_date, description, amount) — handles same-day duplicate descriptions only by also matching amount.
CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_unique_per_source
  ON bank_transactions (agency_id, bank_account_id, transaction_date, description, amount);

CREATE OR REPLACE FUNCTION public.bulk_insert_bank_transactions(rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_count int;
BEGIN
  INSERT INTO bank_transactions (
    id, agency_id, bank_account_id, transaction_date, description, amount,
    transaction_type, counterparty, category, split_label, memo,
    source_document_id, created_at
  )
  SELECT
    gen_random_uuid(),
    (r->>'agency_id')::uuid,
    (r->>'bank_account_id')::uuid,
    (r->>'transaction_date')::date,
    r->>'description',
    (r->>'amount')::numeric,
    r->>'transaction_type',
    r->>'counterparty',
    r->>'category',
    r->>'split_label',
    r->>'memo',
    (r->>'source_document_id')::uuid,
    NOW()
  FROM jsonb_array_elements(rows) r
  ON CONFLICT (agency_id, bank_account_id, transaction_date, description, amount) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.bulk_insert_bank_transactions(jsonb) TO anon, authenticated, service_role;
