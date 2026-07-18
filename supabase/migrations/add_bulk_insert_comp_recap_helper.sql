CREATE OR REPLACE FUNCTION bulk_insert_comp_recap(rows jsonb)
RETURNS int 
LANGUAGE plpgsql 
SECURITY DEFINER 
AS $$
DECLARE
  v_count int;
BEGIN
  INSERT INTO comp_recap (
    id, agency_id, period_year, period_month,
    comp_type, comp_category, description, amount,
    is_aipp_eligible, is_scoreboard_eligible,
    source_document_id, created_at
  )
  SELECT 
    gen_random_uuid(),
    (r->>'agency_id')::uuid,
    (r->>'period_year')::int,
    (r->>'period_month')::int,
    r->>'comp_type',
    r->>'comp_category',
    r->>'description',
    (r->>'amount')::numeric,
    (r->>'is_aipp_eligible')::boolean,
    (r->>'is_scoreboard_eligible')::boolean,
    (r->>'source_document_id')::uuid,
    NOW()
  FROM jsonb_array_elements(rows) r
  ON CONFLICT (agency_id, source_document_id, comp_category, description) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION bulk_insert_comp_recap(jsonb) IS 'Bulk insert comp_recap rows from a JSONB array. Used by the historical backfill workflow. Idempotent via the unique line-per-source constraint.';
