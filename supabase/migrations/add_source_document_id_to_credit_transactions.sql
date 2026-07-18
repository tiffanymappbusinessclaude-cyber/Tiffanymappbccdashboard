ALTER TABLE credit_transactions
  ADD COLUMN IF NOT EXISTS source_document_id uuid REFERENCES documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_credit_transactions_source_document 
  ON credit_transactions(source_document_id);

COMMENT ON COLUMN credit_transactions.source_document_id IS 
  'Link to documents.id for the credit-card statement PDF the transaction was parsed from. NULL for transactions added through other paths (manual entry, future Plaid sync, etc.).';
