-- =============================================================================
-- migrations/109_premium_personnel_files.sql
-- -----------------------------------------------------------------------------
-- Overlay: bcc-premium-overlay v0.5.8
-- Ships: Module 07 — Personnel Files (spec §4.7)
--
-- §1. EXTREME-PII COMPLIANCE MODULE
-- Personnel Files stores the most sensitive employee data of any Premium
-- module: offer letters, contracts, performance reviews, warnings,
-- disciplinary docs, termination records, tax forms (W-4/I-9), potentially
-- medical accommodations. Every design decision here optimizes for
-- CONTAINMENT and AUDITABILITY over convenience.
--
-- STORAGE MODEL (locked 2026-07-12 with Rebecca):
-- File bytes DO NOT live in this database. Every document is stored in the
-- agent's own Google Drive folder at /BCC/HR/Personnel Records/[staff_id]/,
-- uploaded via the Composio Google Drive integration. This database stores
-- ONLY the metadata + drive_file_id reference. The agent's Google Drive
-- ACL is the authoritative access control for the file bytes; our RLS +
-- reveal RPC is the authoritative access control for the metadata + audit
-- trail. Consequence: agents without Google Drive connected via Composio
-- CANNOT install this module (install script gates on the connection).
--
-- §2. B.11 = FALSE (CANONICAL — SECOND MODULE IN A ROW TO HOLD CANONICAL)
-- Producer Isolation Principle B.11 default = FALSE. This is unambiguously
-- correct for Personnel Files:
--   * Owner: unconditional CRUD on own agency's files, documents, templates,
--     grants, and access log.
--   * Office Manager: NO access by default. Enabled via TWO independent
--     mechanisms (layered per Q5 ratification):
--       (a) Global gate: enable_personnel_files_manager_access. When TRUE,
--           manager gets access to ALL employees' files in the agency.
--       (b) Per-employee grant: personnel_file_manager_grants table. Owner
--           explicitly grants a specific manager access to a specific
--           employee's file. Additive with global gate.
--   * Producer: reads own personnel_files wrapper row + own documents
--     where is_employee_visible=TRUE. Inserts own documents ONLY for
--     doc_type values marked producer_uploadable=TRUE in the agency's
--     form templates. Cannot update or delete (immutable after upload).
--     Owner reviews and marks verified via rpc_verify_personnel_document.
--   * Access log: owner + gated-manager READ only. Producer does NOT see
--     who accessed their file (Q4=B ratification — matches HR norm).
--
-- §3. SPEC REVIEW BLOCK RATIFICATIONS (2026-07-12 session with Rebecca)
-- Q1 DOC TYPES: fixed 10-preset enum: offer_letter, contract, review,
--    warning, disciplinary, termination, medical_accommodation, w4, i9, other
-- Q2 STORAGE: Google Drive via Composio (owner-scoped OAuth). Form templates
--    surface with agency-configurable list of blank fillable-form URLs.
--    Seeded on install with federal W-4 (2026) and I-9 (2026). Employee
--    upload flow: download blank → fill → upload back through BCC UI →
--    Supabase Edge Function bridge → Composio → Drive → we record metadata.
--    PREREQ: Google Drive connected at install time.
-- Q3 REVEAL FLOW: reason modal (VARCHAR 200 + PII lint) BEFORE reveal;
--    rpc_reveal_personnel_document logs access and returns drive_file_url.
-- Q4 PRODUCER TRANSPARENCY: owner/manager-only access logs. Producer does
--    NOT see who accessed their file. Traditional HR model.
-- Q5 MANAGER GATE: BOTH LAYERED — global gate (canonical FALSE default)
--    PLUS per-employee override table. is_personnel_files_manager(target)
--    accepts a target and returns TRUE if either gate is open.
-- Q6 PRODUCER WRITE: INSERT-only for doc_types with producer_uploadable=TRUE
--    on the agency's form templates. No UPDATE, no DELETE. Immutable
--    after upload. Owner verifies via rpc_verify_personnel_document.
-- Q7 DELETE SEMANTICS: soft-delete DB (is_active=FALSE) + hard-delete
--    Google Drive (via Composio in the RPC / UI layer). Access log stays
--    queryable forever. Owner-only.
-- Q8 SEED PROMPTS: 4 shipped to Base master PlaybookGuide.jsx (paired
--    commit): onboarding completion status, unverified queue, send links
--    to complete I-9/W-4, missing I-9/W-4 compliance-catch.
-- =============================================================================

-- §4. TABLE: public.personnel_files
CREATE TABLE IF NOT EXISTS public.personnel_files (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             UUID          NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  staff_id              UUID          NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  drive_folder_id       TEXT,
  drive_folder_url      TEXT,
  notes                 VARCHAR(500),
  is_active             BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT personnel_files_one_per_staff_uq UNIQUE (agency_id, staff_id)
);
CREATE INDEX IF NOT EXISTS idx_personnel_files_agency_active ON public.personnel_files (agency_id, is_active);
CREATE INDEX IF NOT EXISTS idx_personnel_files_staff ON public.personnel_files (staff_id);
COMMENT ON TABLE public.personnel_files IS
  'Wrapper record per (agency, staff). One row per employee. Auto-created on first document upload. Metadata only — file bytes live in Google Drive at /BCC/HR/Personnel Records/[staff_id]/ via Composio.';

-- §5. TABLE: public.personnel_documents
CREATE TABLE IF NOT EXISTS public.personnel_documents (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             UUID          NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  personnel_file_id     UUID          NOT NULL REFERENCES public.personnel_files(id) ON DELETE CASCADE,
  doc_type              TEXT          NOT NULL,
  title                 VARCHAR(200)  NOT NULL,
  drive_file_id         TEXT          NOT NULL,
  drive_file_url        TEXT          NOT NULL,
  original_filename     VARCHAR(255),
  file_size_bytes       BIGINT,
  mime_type             VARCHAR(100),
  effective_date        DATE,
  expiration_date       DATE,
  uploaded_by_staff_id  UUID          NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  uploaded_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  verified_at           TIMESTAMPTZ,
  verified_by_staff_id  UUID          REFERENCES public.staff(id) ON DELETE SET NULL,
  is_employee_visible   BOOLEAN       NOT NULL DEFAULT FALSE,
  is_active             BOOLEAN       NOT NULL DEFAULT TRUE,
  notes                 VARCHAR(500),
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT personnel_documents_doc_type_chk CHECK (doc_type IN (
    'offer_letter','contract','review','warning','disciplinary','termination',
    'medical_accommodation','w4','i9','other'
  )),
  CONSTRAINT personnel_documents_verified_pair_chk CHECK (
    (verified_at IS NULL AND verified_by_staff_id IS NULL) OR
    (verified_at IS NOT NULL AND verified_by_staff_id IS NOT NULL)
  ),
  CONSTRAINT personnel_documents_drive_file_id_nonempty_chk CHECK (length(trim(drive_file_id)) > 0),
  CONSTRAINT personnel_documents_title_nonempty_chk CHECK (length(trim(title)) > 0)
);
CREATE INDEX IF NOT EXISTS idx_personnel_documents_file ON public.personnel_documents (personnel_file_id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_personnel_documents_agency_type ON public.personnel_documents (agency_id, doc_type) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_personnel_documents_unverified ON public.personnel_documents (agency_id, uploaded_at) WHERE verified_at IS NULL AND is_active = TRUE;
COMMENT ON TABLE public.personnel_documents IS
  'Individual document rows. File bytes stored in Google Drive; this table holds only drive_file_id + metadata. Producer INSERTs are immutable (no UPDATE, no DELETE) — verification and visibility toggles are owner/gated-manager writes via RLS. Soft-deleted rows (is_active=FALSE) retain the audit trail after Google Drive bytes are hard-deleted.';

-- §6. TABLE: public.personnel_form_templates
CREATE TABLE IF NOT EXISTS public.personnel_form_templates (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             UUID          NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  name                  VARCHAR(200)  NOT NULL,
  description           VARCHAR(500),
  url                   TEXT          NOT NULL,
  form_category         TEXT          NOT NULL,
  doc_type_produced     TEXT          NOT NULL,
  is_required           BOOLEAN       NOT NULL DEFAULT FALSE,
  producer_uploadable   BOOLEAN       NOT NULL DEFAULT FALSE,
  display_order         INTEGER       NOT NULL DEFAULT 100,
  is_active             BOOLEAN       NOT NULL DEFAULT TRUE,
  created_by_staff_id   UUID          REFERENCES public.staff(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT personnel_form_templates_form_category_chk CHECK (form_category IN (
    'federal_tax','state_tax','local_tax','employment_authorization',
    'benefits_election','agency_policy','other'
  )),
  CONSTRAINT personnel_form_templates_doc_type_produced_chk CHECK (doc_type_produced IN (
    'offer_letter','contract','review','warning','disciplinary','termination',
    'medical_accommodation','w4','i9','other'
  )),
  CONSTRAINT personnel_form_templates_url_nonempty_chk CHECK (length(trim(url)) > 0),
  CONSTRAINT personnel_form_templates_name_nonempty_chk CHECK (length(trim(name)) > 0)
);
CREATE INDEX IF NOT EXISTS idx_personnel_form_templates_agency_active ON public.personnel_form_templates (agency_id, is_active, display_order);
CREATE INDEX IF NOT EXISTS idx_personnel_form_templates_producer_uploadable ON public.personnel_form_templates (agency_id, producer_uploadable) WHERE producer_uploadable = TRUE AND is_active = TRUE;
COMMENT ON TABLE public.personnel_form_templates IS
  'Agency-configurable list of blank fillable-form URLs (W-4, I-9, state/local tax forms, etc.). Seeded with federal W-4 and I-9 on install; owner adds state/local via their Claude. producer_uploadable=TRUE means a producer can upload their completed version via the BCC My Forms surface (RLS enforces).';

-- §7. TABLE: public.personnel_file_manager_grants
CREATE TABLE IF NOT EXISTS public.personnel_file_manager_grants (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             UUID          NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  manager_staff_id      UUID          NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  target_staff_id       UUID          NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  granted_by_staff_id   UUID          NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  reason                VARCHAR(200),
  granted_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  revoked_at            TIMESTAMPTZ,
  revoked_by_staff_id   UUID          REFERENCES public.staff(id) ON DELETE SET NULL,
  CONSTRAINT personnel_file_manager_grants_unique UNIQUE (agency_id, manager_staff_id, target_staff_id, granted_at),
  CONSTRAINT personnel_file_manager_grants_revoked_pair_chk CHECK (
    (revoked_at IS NULL AND revoked_by_staff_id IS NULL) OR
    (revoked_at IS NOT NULL AND revoked_by_staff_id IS NOT NULL)
  ),
  CONSTRAINT personnel_file_manager_grants_not_self_chk CHECK (manager_staff_id <> target_staff_id)
);
CREATE INDEX IF NOT EXISTS idx_personnel_file_manager_grants_active_lookup ON public.personnel_file_manager_grants (agency_id, manager_staff_id, target_staff_id) WHERE revoked_at IS NULL;
COMMENT ON TABLE public.personnel_file_manager_grants IS
  'Per-employee manager access override (Q5 layered gate). Additive with enable_personnel_files_manager_access global setting. revoked_at NULL = active grant.';

-- §8. TABLE: public.personnel_document_access_log
CREATE TABLE IF NOT EXISTS public.personnel_document_access_log (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             UUID          NOT NULL REFERENCES public.agency(id) ON DELETE RESTRICT,
  document_id           UUID          NOT NULL REFERENCES public.personnel_documents(id) ON DELETE RESTRICT,
  accessed_by_staff_id  UUID          NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  accessed_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  reason                VARCHAR(200),
  accessor_role         TEXT          NOT NULL,
  CONSTRAINT personnel_document_access_log_accessor_role_chk CHECK (accessor_role IN (
    'Owner / Agent','Office Manager','Producer','Setup Technician','other'
  ))
);
CREATE INDEX IF NOT EXISTS idx_personnel_document_access_log_document ON public.personnel_document_access_log (document_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_personnel_document_access_log_accessor ON public.personnel_document_access_log (accessed_by_staff_id, accessed_at DESC);
COMMENT ON TABLE public.personnel_document_access_log IS
  'Immutable audit trail. Every rpc_reveal_personnel_document call logs a row here. INSERT-only (no UPDATE, no DELETE policy). Owner + gated-manager READ. Producer does NOT read (Q4=B ratification, traditional HR model).';

-- §9. TOUCH TRIGGERS
CREATE OR REPLACE FUNCTION public.touch_personnel_files_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION public.touch_personnel_documents_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION public.touch_personnel_form_templates_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;

-- §10. CROSS-TENANT GUARDS
CREATE OR REPLACE FUNCTION public.enforce_personnel_files_staff_agency()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE staff_agency UUID;
BEGIN
  SELECT agency_id INTO staff_agency FROM public.staff WHERE id = NEW.staff_id;
  IF staff_agency IS NULL THEN RAISE EXCEPTION 'personnel_files: staff_id % does not exist', NEW.staff_id USING ERRCODE = '23503'; END IF;
  IF staff_agency <> NEW.agency_id THEN RAISE EXCEPTION 'personnel_files: staff % agency % vs file agency %', NEW.staff_id, staff_agency, NEW.agency_id USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.enforce_personnel_documents_uploader_agency()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uploader_agency UUID; file_agency UUID;
BEGIN
  SELECT agency_id INTO uploader_agency FROM public.staff WHERE id = NEW.uploaded_by_staff_id;
  IF uploader_agency IS NULL THEN RAISE EXCEPTION 'uploader % does not exist', NEW.uploaded_by_staff_id USING ERRCODE = '23503'; END IF;
  IF uploader_agency <> NEW.agency_id THEN RAISE EXCEPTION 'uploader % agency % vs doc agency %', NEW.uploaded_by_staff_id, uploader_agency, NEW.agency_id USING ERRCODE = '23514'; END IF;
  SELECT agency_id INTO file_agency FROM public.personnel_files WHERE id = NEW.personnel_file_id;
  IF file_agency IS NULL THEN RAISE EXCEPTION 'file % does not exist', NEW.personnel_file_id USING ERRCODE = '23503'; END IF;
  IF file_agency <> NEW.agency_id THEN RAISE EXCEPTION 'file % agency % vs doc agency %', NEW.personnel_file_id, file_agency, NEW.agency_id USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.enforce_personnel_form_templates_creator_agency()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE creator_agency UUID;
BEGIN
  IF NEW.created_by_staff_id IS NULL THEN RETURN NEW; END IF;
  SELECT agency_id INTO creator_agency FROM public.staff WHERE id = NEW.created_by_staff_id;
  IF creator_agency IS NULL THEN RAISE EXCEPTION 'creator % does not exist', NEW.created_by_staff_id USING ERRCODE = '23503'; END IF;
  IF creator_agency <> NEW.agency_id THEN RAISE EXCEPTION 'creator agency mismatch' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.enforce_personnel_file_manager_grants_agency()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE mgr_agency UUID; tgt_agency UUID; grantor_agency UUID;
BEGIN
  SELECT agency_id INTO mgr_agency     FROM public.staff WHERE id = NEW.manager_staff_id;
  SELECT agency_id INTO tgt_agency     FROM public.staff WHERE id = NEW.target_staff_id;
  SELECT agency_id INTO grantor_agency FROM public.staff WHERE id = NEW.granted_by_staff_id;
  IF mgr_agency IS NULL OR tgt_agency IS NULL OR grantor_agency IS NULL THEN
    RAISE EXCEPTION 'grant staff not found' USING ERRCODE = '23503';
  END IF;
  IF NEW.agency_id NOT IN (mgr_agency, tgt_agency, grantor_agency)
     OR mgr_agency <> tgt_agency OR mgr_agency <> grantor_agency THEN
    RAISE EXCEPTION 'grant cross-tenant blocked' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;

-- §11. VISIBILITY DEFAULT SETTER
CREATE OR REPLACE FUNCTION public.set_personnel_documents_visibility_default()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.is_employee_visible := (NEW.doc_type IN ('offer_letter','contract','w4','i9'));
  END IF;
  RETURN NEW;
END; $$;

-- §12. TRIGGER CREATE STATEMENTS
CREATE TRIGGER trg_personnel_files_staff_agency
  BEFORE INSERT OR UPDATE OF staff_id, agency_id ON public.personnel_files
  FOR EACH ROW EXECUTE FUNCTION public.enforce_personnel_files_staff_agency();
CREATE TRIGGER trg_personnel_files_touch
  BEFORE UPDATE ON public.personnel_files
  FOR EACH ROW EXECUTE FUNCTION public.touch_personnel_files_updated_at();
CREATE TRIGGER trg_personnel_documents_uploader_agency
  BEFORE INSERT OR UPDATE OF uploaded_by_staff_id, agency_id, personnel_file_id ON public.personnel_documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_personnel_documents_uploader_agency();
CREATE TRIGGER trg_personnel_documents_visibility_default
  BEFORE INSERT ON public.personnel_documents
  FOR EACH ROW EXECUTE FUNCTION public.set_personnel_documents_visibility_default();
CREATE TRIGGER trg_personnel_documents_touch
  BEFORE UPDATE ON public.personnel_documents
  FOR EACH ROW EXECUTE FUNCTION public.touch_personnel_documents_updated_at();
CREATE TRIGGER trg_personnel_form_templates_creator_agency
  BEFORE INSERT OR UPDATE OF created_by_staff_id, agency_id ON public.personnel_form_templates
  FOR EACH ROW EXECUTE FUNCTION public.enforce_personnel_form_templates_creator_agency();
CREATE TRIGGER trg_personnel_form_templates_touch
  BEFORE UPDATE ON public.personnel_form_templates
  FOR EACH ROW EXECUTE FUNCTION public.touch_personnel_form_templates_updated_at();
CREATE TRIGGER trg_personnel_file_manager_grants_agency
  BEFORE INSERT OR UPDATE OF manager_staff_id, target_staff_id, granted_by_staff_id, agency_id ON public.personnel_file_manager_grants
  FOR EACH ROW EXECUTE FUNCTION public.enforce_personnel_file_manager_grants_agency();

-- §13. MANAGER GATE FUNCTION (Q5 layered)
CREATE OR REPLACE FUNCTION public.is_personnel_files_manager(p_target_staff_id UUID)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller_staff_id UUID;
  v_caller_agency   UUID;
  v_target_agency   UUID;
  v_global_gate     BOOLEAN;
  v_grant_exists    BOOLEAN;
BEGIN
  SELECT s.id, s.agency_id INTO v_caller_staff_id, v_caller_agency
    FROM public.staff s
   WHERE s.auth_user_id = auth.uid() AND s.role = 'Office Manager' AND s.status = 'active'
   LIMIT 1;
  IF v_caller_staff_id IS NULL THEN RETURN FALSE; END IF;
  SELECT agency_id INTO v_target_agency FROM public.staff WHERE id = p_target_staff_id;
  IF v_target_agency IS NULL OR v_target_agency <> v_caller_agency THEN RETURN FALSE; END IF;
  SELECT COALESCE(lower(setting_value) = 'true', FALSE) INTO v_global_gate
    FROM public.settings
   WHERE agency_id = v_caller_agency AND setting_key = 'enable_personnel_files_manager_access'
   LIMIT 1;
  IF v_global_gate THEN RETURN TRUE; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.personnel_file_manager_grants g
     WHERE g.agency_id = v_caller_agency
       AND g.manager_staff_id = v_caller_staff_id
       AND g.target_staff_id = p_target_staff_id
       AND g.revoked_at IS NULL
  ) INTO v_grant_exists;
  RETURN v_grant_exists;
END;
$fn$;
REVOKE ALL ON FUNCTION public.is_personnel_files_manager(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_personnel_files_manager(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_personnel_files_manager(UUID) TO service_role;
COMMENT ON FUNCTION public.is_personnel_files_manager(UUID) IS
  'B.11 manager gate for Personnel Files (Q5 layered model). Returns TRUE when caller is active Office Manager AND either the global gate enable_personnel_files_manager_access is TRUE OR a per-employee grant exists in personnel_file_manager_grants for (caller, target_staff_id) that has not been revoked. Cross-tenant guarded (target must be in caller agency).';

-- §14. RLS ENABLE + POLICIES
ALTER TABLE public.personnel_files                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.personnel_documents              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.personnel_form_templates         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.personnel_file_manager_grants    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.personnel_document_access_log    ENABLE ROW LEVEL SECURITY;

CREATE POLICY personnel_files_owner_all ON public.personnel_files FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.staff s WHERE s.auth_user_id = auth.uid()
                 AND s.role = 'Owner / Agent' AND s.status = 'active' AND s.agency_id = personnel_files.agency_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.staff s WHERE s.auth_user_id = auth.uid()
                      AND s.role = 'Owner / Agent' AND s.status = 'active' AND s.agency_id = personnel_files.agency_id));
CREATE POLICY personnel_files_manager_gated ON public.personnel_files FOR ALL TO authenticated
  USING (public.is_personnel_files_manager(personnel_files.staff_id))
  WITH CHECK (public.is_personnel_files_manager(personnel_files.staff_id));
CREATE POLICY personnel_files_producer_read_own ON public.personnel_files FOR SELECT TO authenticated
  USING (staff_id = public.current_staff_id());

CREATE POLICY personnel_documents_owner_all ON public.personnel_documents FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.staff s WHERE s.auth_user_id = auth.uid()
                 AND s.role = 'Owner / Agent' AND s.status = 'active' AND s.agency_id = personnel_documents.agency_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.staff s WHERE s.auth_user_id = auth.uid()
                      AND s.role = 'Owner / Agent' AND s.status = 'active' AND s.agency_id = personnel_documents.agency_id));
CREATE POLICY personnel_documents_manager_gated ON public.personnel_documents FOR ALL TO authenticated
  USING (public.is_personnel_files_manager(
    (SELECT pf.staff_id FROM public.personnel_files pf WHERE pf.id = personnel_documents.personnel_file_id)
  ))
  WITH CHECK (public.is_personnel_files_manager(
    (SELECT pf.staff_id FROM public.personnel_files pf WHERE pf.id = personnel_documents.personnel_file_id)
  ));
CREATE POLICY personnel_documents_producer_read_own ON public.personnel_documents FOR SELECT TO authenticated
  USING (
    is_employee_visible = TRUE AND is_active = TRUE
    AND EXISTS (SELECT 1 FROM public.personnel_files pf
                 WHERE pf.id = personnel_documents.personnel_file_id
                   AND pf.staff_id = public.current_staff_id())
  );
CREATE POLICY personnel_documents_producer_insert ON public.personnel_documents FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.personnel_files pf
             WHERE pf.id = personnel_documents.personnel_file_id
               AND pf.staff_id = public.current_staff_id())
    AND EXISTS (SELECT 1 FROM public.personnel_form_templates pft
                 WHERE pft.agency_id = personnel_documents.agency_id
                   AND pft.doc_type_produced = personnel_documents.doc_type
                   AND pft.producer_uploadable = TRUE AND pft.is_active = TRUE)
    AND verified_at IS NULL AND verified_by_staff_id IS NULL
    AND uploaded_by_staff_id = public.current_staff_id()
  );

CREATE POLICY personnel_form_templates_owner_all ON public.personnel_form_templates FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.staff s WHERE s.auth_user_id = auth.uid()
                 AND s.role = 'Owner / Agent' AND s.status = 'active' AND s.agency_id = personnel_form_templates.agency_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.staff s WHERE s.auth_user_id = auth.uid()
                      AND s.role = 'Owner / Agent' AND s.status = 'active' AND s.agency_id = personnel_form_templates.agency_id));
CREATE POLICY personnel_form_templates_all_read ON public.personnel_form_templates FOR SELECT TO authenticated
  USING (is_active = TRUE
         AND agency_id = (SELECT s.agency_id FROM public.staff s WHERE s.auth_user_id = auth.uid() LIMIT 1));

CREATE POLICY personnel_file_manager_grants_owner_all ON public.personnel_file_manager_grants FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.staff s WHERE s.auth_user_id = auth.uid()
                 AND s.role = 'Owner / Agent' AND s.status = 'active' AND s.agency_id = personnel_file_manager_grants.agency_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.staff s WHERE s.auth_user_id = auth.uid()
                      AND s.role = 'Owner / Agent' AND s.status = 'active' AND s.agency_id = personnel_file_manager_grants.agency_id));
CREATE POLICY personnel_file_manager_grants_manager_read_own ON public.personnel_file_manager_grants FOR SELECT TO authenticated
  USING (
    manager_staff_id = public.current_staff_id()
    AND EXISTS (SELECT 1 FROM public.staff s WHERE s.auth_user_id = auth.uid()
                AND s.role = 'Office Manager' AND s.status = 'active')
  );

CREATE POLICY personnel_document_access_log_owner_read ON public.personnel_document_access_log FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.staff s WHERE s.auth_user_id = auth.uid()
                 AND s.role = 'Owner / Agent' AND s.status = 'active' AND s.agency_id = personnel_document_access_log.agency_id));
CREATE POLICY personnel_document_access_log_manager_read ON public.personnel_document_access_log FOR SELECT TO authenticated
  USING (public.is_personnel_files_manager(
    (SELECT pf.staff_id FROM public.personnel_files pf
      JOIN public.personnel_documents pd ON pd.personnel_file_id = pf.id
     WHERE pd.id = personnel_document_access_log.document_id)
  ));
CREATE POLICY personnel_document_access_log_authenticated_insert ON public.personnel_document_access_log FOR INSERT TO authenticated
  WITH CHECK (
    accessed_by_staff_id = public.current_staff_id()
    AND agency_id = (SELECT s.agency_id FROM public.staff s WHERE s.auth_user_id = auth.uid() LIMIT 1)
  );
-- NOTE: no UPDATE/DELETE policy on personnel_document_access_log — rows are immutable once inserted.

-- §15. RPC: rpc_reveal_personnel_document(doc_id, reason)
CREATE OR REPLACE FUNCTION public.rpc_reveal_personnel_document(p_document_id UUID, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller_staff_id UUID; v_caller_role TEXT; v_caller_agency UUID;
  v_doc public.personnel_documents%ROWTYPE; v_file_staff_id UUID; v_reason_clean VARCHAR(200);
BEGIN
  SELECT s.id, s.role, s.agency_id INTO v_caller_staff_id, v_caller_role, v_caller_agency
    FROM public.staff s WHERE s.auth_user_id = auth.uid() AND s.status = 'active' LIMIT 1;
  IF v_caller_staff_id IS NULL THEN RAISE EXCEPTION 'no active caller' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_doc FROM public.personnel_documents WHERE id = p_document_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'document % not found', p_document_id USING ERRCODE = '23503'; END IF;
  IF v_doc.agency_id <> v_caller_agency THEN RAISE EXCEPTION 'cross-tenant call blocked' USING ERRCODE = '42501'; END IF;
  IF v_doc.is_active = FALSE THEN RAISE EXCEPTION 'document archived' USING ERRCODE = '22023'; END IF;
  SELECT staff_id INTO v_file_staff_id FROM public.personnel_files WHERE id = v_doc.personnel_file_id;
  IF v_caller_role = 'Owner / Agent' THEN NULL;
  ELSIF v_file_staff_id = v_caller_staff_id AND v_doc.is_employee_visible = TRUE THEN NULL;
  ELSIF v_caller_role = 'Office Manager' AND public.is_personnel_files_manager(v_file_staff_id) THEN NULL;
  ELSE RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'; END IF;
  v_reason_clean := NULLIF(trim(coalesce(p_reason, '')), '');
  IF v_caller_staff_id <> v_file_staff_id AND (v_reason_clean IS NULL OR length(v_reason_clean) < 3) THEN
    RAISE EXCEPTION 'reason required (min 3 chars) for cross-employee reveal' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.personnel_document_access_log (agency_id, document_id, accessed_by_staff_id, accessed_at, reason, accessor_role)
  VALUES (v_caller_agency, p_document_id, v_caller_staff_id, now(), v_reason_clean,
          CASE WHEN v_caller_role IN ('Owner / Agent','Office Manager','Producer','Setup Technician') THEN v_caller_role ELSE 'other' END);
  RETURN jsonb_build_object(
    'document_id', v_doc.id, 'drive_file_id', v_doc.drive_file_id, 'drive_file_url', v_doc.drive_file_url,
    'doc_type', v_doc.doc_type, 'title', v_doc.title, 'original_filename', v_doc.original_filename,
    'file_size_bytes', v_doc.file_size_bytes, 'mime_type', v_doc.mime_type,
    'uploaded_at', v_doc.uploaded_at, 'verified_at', v_doc.verified_at,
    'is_employee_visible', v_doc.is_employee_visible, 'access_logged', TRUE);
END; $$;
REVOKE ALL ON FUNCTION public.rpc_reveal_personnel_document(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_reveal_personnel_document(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_reveal_personnel_document(UUID, TEXT) TO service_role;
COMMENT ON FUNCTION public.rpc_reveal_personnel_document(UUID, TEXT) IS
  'Reveal document Drive URL after logging access. Owner unconditional; manager gated by is_personnel_files_manager(target); producer only for own employee-visible docs. Reason required (min 3 chars) for cross-employee reveals. Cross-tenant raises 42501. Soft-deleted docs raise 22023.';

-- §16. RPC: rpc_verify_personnel_document
CREATE OR REPLACE FUNCTION public.rpc_verify_personnel_document(p_document_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_caller_staff_id UUID; v_caller_role TEXT; v_caller_agency UUID;
        v_doc public.personnel_documents%ROWTYPE; v_file_staff_id UUID;
BEGIN
  SELECT s.id, s.role, s.agency_id INTO v_caller_staff_id, v_caller_role, v_caller_agency
    FROM public.staff s WHERE s.auth_user_id = auth.uid() AND s.status = 'active' LIMIT 1;
  IF v_caller_staff_id IS NULL THEN RAISE EXCEPTION 'no active caller' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_doc FROM public.personnel_documents WHERE id = p_document_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'document not found' USING ERRCODE = '23503'; END IF;
  IF v_doc.agency_id <> v_caller_agency THEN RAISE EXCEPTION 'cross-tenant blocked' USING ERRCODE = '42501'; END IF;
  IF v_doc.is_active = FALSE THEN RAISE EXCEPTION 'document archived' USING ERRCODE = '22023'; END IF;
  IF v_doc.verified_at IS NOT NULL THEN RAISE EXCEPTION 'already verified at %', v_doc.verified_at USING ERRCODE = '22023'; END IF;
  SELECT staff_id INTO v_file_staff_id FROM public.personnel_files WHERE id = v_doc.personnel_file_id;
  IF v_caller_role <> 'Owner / Agent' AND NOT (v_caller_role = 'Office Manager' AND public.is_personnel_files_manager(v_file_staff_id)) THEN
    RAISE EXCEPTION 'only owner or gated-manager can verify' USING ERRCODE = '42501';
  END IF;
  UPDATE public.personnel_documents SET verified_at = now(), verified_by_staff_id = v_caller_staff_id WHERE id = p_document_id;
  RETURN jsonb_build_object('document_id', p_document_id, 'verified_at', now(), 'verified_by_staff_id', v_caller_staff_id);
END; $$;
REVOKE ALL ON FUNCTION public.rpc_verify_personnel_document(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_verify_personnel_document(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_verify_personnel_document(UUID) TO service_role;
COMMENT ON FUNCTION public.rpc_verify_personnel_document(UUID) IS
  'Owner or gated-manager marks a document as verified (received + reviewed). Idempotent-safe: raises 22023 if already verified. Cross-tenant raises 42501.';

-- §17. RPC: rpc_get_personnel_summary
CREATE OR REPLACE FUNCTION public.rpc_get_personnel_summary(p_target_staff_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_caller_staff_id UUID; v_caller_role TEXT; v_caller_agency UUID; v_target_agency UUID;
        v_file_id UUID; v_doc_counts JSONB; v_verified_count INTEGER; v_unverified_count INTEGER; v_missing_required INTEGER;
BEGIN
  SELECT s.id, s.role, s.agency_id INTO v_caller_staff_id, v_caller_role, v_caller_agency
    FROM public.staff s WHERE s.auth_user_id = auth.uid() AND s.status = 'active' LIMIT 1;
  IF v_caller_staff_id IS NULL THEN RAISE EXCEPTION 'no active caller' USING ERRCODE = '42501'; END IF;
  SELECT agency_id INTO v_target_agency FROM public.staff WHERE id = p_target_staff_id;
  IF v_target_agency IS NULL THEN RAISE EXCEPTION 'target not found' USING ERRCODE = '23503'; END IF;
  IF v_target_agency <> v_caller_agency THEN RAISE EXCEPTION 'cross-tenant blocked' USING ERRCODE = '42501'; END IF;
  IF v_caller_role = 'Owner / Agent' THEN NULL;
  ELSIF p_target_staff_id = v_caller_staff_id THEN NULL;
  ELSIF v_caller_role = 'Office Manager' AND public.is_personnel_files_manager(p_target_staff_id) THEN NULL;
  ELSE RAISE EXCEPTION 'not authorized for target' USING ERRCODE = '42501'; END IF;
  SELECT id INTO v_file_id FROM public.personnel_files
   WHERE agency_id = v_target_agency AND staff_id = p_target_staff_id AND is_active = TRUE;
  IF v_file_id IS NULL THEN
    RETURN jsonb_build_object('target_staff_id', p_target_staff_id, 'file_exists', FALSE,
      'doc_counts', '{}'::jsonb, 'verified_count', 0, 'unverified_count', 0,
      'missing_required_forms', jsonb_build_array());
  END IF;
  SELECT COALESCE(jsonb_object_agg(doc_type, cnt), '{}'::jsonb) INTO v_doc_counts
    FROM (SELECT doc_type, COUNT(*)::INTEGER AS cnt FROM public.personnel_documents
           WHERE personnel_file_id = v_file_id AND is_active = TRUE GROUP BY doc_type) t;
  SELECT COUNT(*) FILTER (WHERE verified_at IS NOT NULL)::INTEGER,
         COUNT(*) FILTER (WHERE verified_at IS NULL)::INTEGER
    INTO v_verified_count, v_unverified_count
    FROM public.personnel_documents WHERE personnel_file_id = v_file_id AND is_active = TRUE;
  SELECT COUNT(*)::INTEGER INTO v_missing_required
    FROM public.personnel_form_templates pft
   WHERE pft.agency_id = v_target_agency AND pft.is_required = TRUE AND pft.is_active = TRUE
     AND NOT EXISTS (SELECT 1 FROM public.personnel_documents pd
                      WHERE pd.personnel_file_id = v_file_id AND pd.is_active = TRUE
                        AND pd.doc_type = pft.doc_type_produced);
  RETURN jsonb_build_object('target_staff_id', p_target_staff_id, 'file_exists', TRUE,
    'file_id', v_file_id, 'doc_counts', v_doc_counts,
    'verified_count', v_verified_count, 'unverified_count', v_unverified_count,
    'missing_required_count', v_missing_required);
END; $$;
REVOKE ALL ON FUNCTION public.rpc_get_personnel_summary(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_get_personnel_summary(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_personnel_summary(UUID) TO service_role;
COMMENT ON FUNCTION public.rpc_get_personnel_summary(UUID) IS
  'Non-sensitive metadata summary for a personnel file: doc counts by type, verified/unverified counts, missing required forms count. NO document contents or Drive URLs.';

-- §18. RPC: rpc_grant_manager_personnel_access
CREATE OR REPLACE FUNCTION public.rpc_grant_manager_personnel_access(
  p_manager_staff_id UUID, p_target_staff_id UUID, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_caller_staff_id UUID; v_caller_agency UUID; v_grant_id UUID;
BEGIN
  SELECT s.id, s.agency_id INTO v_caller_staff_id, v_caller_agency
    FROM public.staff s WHERE s.auth_user_id = auth.uid()
     AND s.role = 'Owner / Agent' AND s.status = 'active' LIMIT 1;
  IF v_caller_staff_id IS NULL THEN RAISE EXCEPTION 'only Owner can grant' USING ERRCODE = '42501'; END IF;
  IF p_manager_staff_id = p_target_staff_id THEN RAISE EXCEPTION 'manager and target cannot be same' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.personnel_file_manager_grants (
    agency_id, manager_staff_id, target_staff_id, granted_by_staff_id, reason, granted_at
  ) VALUES (v_caller_agency, p_manager_staff_id, p_target_staff_id, v_caller_staff_id,
            NULLIF(trim(coalesce(p_reason, '')), ''), now())
  RETURNING id INTO v_grant_id;
  RETURN jsonb_build_object('grant_id', v_grant_id, 'manager_staff_id', p_manager_staff_id,
    'target_staff_id', p_target_staff_id, 'granted_by', v_caller_staff_id, 'granted_at', now());
END; $$;
REVOKE ALL ON FUNCTION public.rpc_grant_manager_personnel_access(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_grant_manager_personnel_access(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_grant_manager_personnel_access(UUID, UUID, TEXT) TO service_role;

-- §19. RPC: rpc_revoke_manager_personnel_access
CREATE OR REPLACE FUNCTION public.rpc_revoke_manager_personnel_access(p_grant_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_caller_staff_id UUID; v_caller_agency UUID;
        v_grant public.personnel_file_manager_grants%ROWTYPE;
BEGIN
  SELECT s.id, s.agency_id INTO v_caller_staff_id, v_caller_agency
    FROM public.staff s WHERE s.auth_user_id = auth.uid()
     AND s.role = 'Owner / Agent' AND s.status = 'active' LIMIT 1;
  IF v_caller_staff_id IS NULL THEN RAISE EXCEPTION 'only Owner can revoke' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_grant FROM public.personnel_file_manager_grants WHERE id = p_grant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'grant not found' USING ERRCODE = '23503'; END IF;
  IF v_grant.agency_id <> v_caller_agency THEN RAISE EXCEPTION 'cross-tenant blocked' USING ERRCODE = '42501'; END IF;
  IF v_grant.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'already revoked' USING ERRCODE = '22023'; END IF;
  UPDATE public.personnel_file_manager_grants
     SET revoked_at = now(), revoked_by_staff_id = v_caller_staff_id
   WHERE id = p_grant_id;
  RETURN jsonb_build_object('grant_id', p_grant_id, 'revoked_at', now(), 'revoked_by', v_caller_staff_id);
END; $$;
REVOKE ALL ON FUNCTION public.rpc_revoke_manager_personnel_access(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_revoke_manager_personnel_access(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_revoke_manager_personnel_access(UUID) TO service_role;

-- §20. SETTINGS SEED — CANONICAL FALSE
INSERT INTO public.settings (agency_id, setting_key, setting_value, description)
SELECT a.id, 'enable_personnel_files_manager_access', 'false',
       'Producer Isolation Principle B.11 GLOBAL manager gate for Personnel Files. When true, staff with role=Office Manager can access every employee''s personnel file in this agency (subject to still being active). DEFAULTS FALSE (canonical B.11 — second Premium module in a row to hold canonical). Owner can either flip this setting globally OR issue per-employee grants via rpc_grant_manager_personnel_access (Q5 layered model).'
FROM public.agency a
ON CONFLICT (agency_id, setting_key) DO NOTHING;

-- §21. FORM TEMPLATES SEED — federal W-4 (2026) + I-9 (2026)
INSERT INTO public.personnel_form_templates (
  agency_id, name, description, url, form_category, doc_type_produced,
  is_required, producer_uploadable, display_order, is_active)
SELECT a.id, 'W-4 (2026)',
  'Federal income tax withholding form. New hires complete on start date; existing employees update after major life events (marriage, birth, home purchase).',
  'https://www.irs.gov/pub/irs-pdf/fw4.pdf',
  'federal_tax', 'w4', TRUE, TRUE, 10, TRUE
FROM public.agency a
WHERE NOT EXISTS (SELECT 1 FROM public.personnel_form_templates pft
                   WHERE pft.agency_id = a.id AND pft.doc_type_produced = 'w4' AND pft.name LIKE 'W-4%');

INSERT INTO public.personnel_form_templates (
  agency_id, name, description, url, form_category, doc_type_produced,
  is_required, producer_uploadable, display_order, is_active)
SELECT a.id, 'I-9 (2026)',
  'Employment Eligibility Verification. USCIS-required for all new hires within 3 business days of start date. Employee completes Section 1; employer completes Section 2 with verified identity + work authorization documents.',
  'https://www.uscis.gov/sites/default/files/document/forms/i-9.pdf',
  'employment_authorization', 'i9', TRUE, TRUE, 20, TRUE
FROM public.agency a
WHERE NOT EXISTS (SELECT 1 FROM public.personnel_form_templates pft
                   WHERE pft.agency_id = a.id AND pft.doc_type_produced = 'i9' AND pft.name LIKE 'I-9%');

-- §22. PROVENANCE
INSERT INTO public._install_provenance (event_type, event_data)
VALUES (
  'overlay_migration_applied',
  jsonb_build_object(
    'migration',              '109_premium_personnel_files',
    'overlay_version',        '0.5.8',
    'ships_module',           'Module 07 — Personnel Files',
    'spec_ref',               '§4.7 + Part I §1',
    'b11_default',            'false (CANONICAL — second Premium module in a row to hold canonical after Scoreboard)',
    'storage_model',          'Google Drive via Composio (owner-scoped OAuth); DB stores drive_file_id + metadata only',
    'manager_gate_model',     'layered: global setting enable_personnel_files_manager_access + per-employee grants via personnel_file_manager_grants (Q5=C ratification)',
    'doc_types',              jsonb_build_array(
                                'offer_letter','contract','review','warning','disciplinary','termination',
                                'medical_accommodation','w4','i9','other'),
    'form_categories',        jsonb_build_array(
                                'federal_tax','state_tax','local_tax','employment_authorization',
                                'benefits_election','agency_policy','other'),
    'new_tables',             jsonb_build_array(
                                'personnel_files','personnel_documents','personnel_form_templates',
                                'personnel_file_manager_grants','personnel_document_access_log'),
    'new_functions',          jsonb_build_array(
                                'is_personnel_files_manager(UUID)',
                                'rpc_reveal_personnel_document(UUID, TEXT)',
                                'rpc_verify_personnel_document(UUID)',
                                'rpc_get_personnel_summary(UUID)',
                                'rpc_grant_manager_personnel_access(UUID, UUID, TEXT)',
                                'rpc_revoke_manager_personnel_access(UUID)',
                                'touch_personnel_files_updated_at()',
                                'touch_personnel_documents_updated_at()',
                                'touch_personnel_form_templates_updated_at()',
                                'set_personnel_documents_visibility_default()',
                                'enforce_personnel_files_staff_agency()',
                                'enforce_personnel_documents_uploader_agency()',
                                'enforce_personnel_form_templates_creator_agency()',
                                'enforce_personnel_file_manager_grants_agency()'),
    'seeded_form_templates',  jsonb_build_array('W-4 (2026)', 'I-9 (2026)'),
    'seeded_forms_urls',      jsonb_build_object(
                                'W-4', 'https://www.irs.gov/pub/irs-pdf/fw4.pdf',
                                'I-9', 'https://www.uscis.gov/sites/default/files/document/forms/i-9.pdf'),
    'install_prereq',         'Google Drive connected via Composio for the agent',
    'depends_on',             jsonb_build_array(),
    'ships_paired_with',      'Base master PlaybookGuide.jsx +4 seed prompts (§4.7 Personnel Files section)'
  )
);
