-- Drop the constraint that was designed for monthly cash-basis aggregation.
-- The recipe-driven flow inserts line items from biweekly AGTCOMP RECAP PDFs,
-- which produce multiple rows per (period, category, description) — one per source PDF.
ALTER TABLE comp_recap 
  DROP CONSTRAINT IF EXISTS comp_recap_agency_id_period_year_period_month_comp_category_key;

-- Replace with a constraint that scopes uniqueness to (source PDF + line description).
-- The existing 51 QBO-derived rows have source_document_id = NULL and unique date-stamped
-- descriptions, so they continue to satisfy uniqueness under default NULL-distinct semantics.
ALTER TABLE comp_recap
  ADD CONSTRAINT comp_recap_unique_line_per_source
  UNIQUE NULLS NOT DISTINCT (agency_id, source_document_id, comp_category, description);

COMMENT ON CONSTRAINT comp_recap_unique_line_per_source ON comp_recap IS
  'Each source document (recap PDF or QBO snapshot) may only contribute one row per (category, description). NULL source_document_id is treated as a distinct sentinel for QBO-derived composite rows.';
