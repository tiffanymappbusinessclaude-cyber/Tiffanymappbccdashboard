-- Historical backfill revealed: one Gmail message can have N attachments,
-- but the old unique index was (agency_id, external_message_id) — only allowing
-- 1 doc per email. Replace with a per-file-per-email constraint that preserves
-- idempotency for the regular parser flow while permitting multi-attachment rows.
DROP INDEX IF EXISTS public.uniq_documents_external_message;
CREATE UNIQUE INDEX uniq_documents_external_message_file
  ON public.documents (agency_id, external_message_id, file_name)
  WHERE external_message_id IS NOT NULL;
