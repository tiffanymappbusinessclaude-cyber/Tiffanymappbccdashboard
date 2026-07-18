CREATE OR REPLACE FUNCTION bulk_insert_credit_transactions(rows jsonb)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE v_count int;
BEGIN
  INSERT INTO credit_transactions (
    id, agency_id, credit_account_id, transaction_date, description, amount,
    transaction_type, category, source_document_id, created_at
  )
  SELECT
    gen_random_uuid(),
    (r->>'agency_id')::uuid,
    (r->>'credit_account_id')::uuid,
    (r->>'transaction_date')::date,
    r->>'description',
    (r->>'amount')::numeric,
    r->>'transaction_type',
    r->>'category',
    (r->>'source_document_id')::uuid,
    NOW()
  FROM jsonb_array_elements(rows) r;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION bulk_insert_credit_transactions(jsonb) IS 
  'Bulk-insert credit_transactions rows from a JSONB array. Used by the historical backfill workflow and the live Credit Card Statement Processor recipe.';
