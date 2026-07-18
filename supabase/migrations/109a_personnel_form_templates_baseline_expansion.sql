-- =====================================================================
-- 109a_personnel_form_templates_baseline_expansion.sql
-- Premium overlay — Personnel Files module
--
-- PURPOSE: Expand the default form template library from 2 (W-4, I-9)
-- to 11 by adding 9 universally-required templates that every SF agency
-- needs on day one. Prior installs shipped with a near-empty Personnel
-- Files module that looked broken until the agent manually configured
-- 10+ templates through the UI.
--
-- Backfilled from a mature client install which had these templates
-- manually seeded post-install by their agency team.
-- Baseline set is state-agnostic; state tax withholding ships as a
-- placeholder (is_required=FALSE, editable per agency's state).
--
-- IDEMPOTENT: Both CHECK constraint extensions and INSERT statements
-- guard against re-application. INSERTs skip if EITHER a matching name
-- OR a matching doc_type_produced already exists for the agency — this
-- prevents duplicates on installs that seeded these templates under the
-- old schema (e.g., demo Supabase eznhwsbofhnggqzwzgfo which mapped
-- Direct Deposit / Handbook / Emergency Contact all to doc_type='other').
--
-- Applied: 2026-07-17 (Rebecca-approved session queue item #1)
-- =====================================================================

-- §1. Extend form_category CHECK to include identity_verification + payroll.
--     These categories exist in the source install and semantically match
--     the templates we ship in §3. Widening the enum lets every install
--     categorize identity documents and payroll documents distinctly from
--     the catch-all 'other' bucket.
ALTER TABLE public.personnel_form_templates
  DROP CONSTRAINT IF EXISTS personnel_form_templates_form_category_chk;
ALTER TABLE public.personnel_form_templates
  ADD CONSTRAINT personnel_form_templates_form_category_chk CHECK (form_category IN (
    'federal_tax','state_tax','local_tax','employment_authorization',
    'benefits_election','agency_policy','identity_verification','payroll','other'
  ));

-- §2. Extend doc_type_produced CHECK to cover the 9 new templates.
--     The prior enum was HR-lifecycle-heavy (offer_letter, warning,
--     termination, etc.); the new values are onboarding/compliance-heavy
--     which is what an SF agent actually needs first.
ALTER TABLE public.personnel_form_templates
  DROP CONSTRAINT IF EXISTS personnel_form_templates_doc_type_produced_chk;
ALTER TABLE public.personnel_form_templates
  ADD CONSTRAINT personnel_form_templates_doc_type_produced_chk CHECK (doc_type_produced IN (
    -- HR lifecycle (from 109)
    'offer_letter','contract','review','warning','disciplinary','termination',
    'medical_accommodation','w4','i9','other',
    -- Onboarding/compliance additions (109a)
    'photo_id','ssn_card','direct_deposit','benefits_election','handbook_ack',
    'social_media_ack','state_tax','emergency_contact','annual_review'
  ));

-- §3. Seed the 9 baseline templates for every existing agency.
--     Compound idempotency: skip if EITHER a same-named template OR a
--     same-doc-type template already exists for that agency. Rationale:
--     old-schema seeds mapped multiple templates to doc_type='other', so
--     name-match protects against duplicating "Direct Deposit Authorization"
--     while doc_type-match protects against duplicating "Photo ID" if
--     it was already added under a different name.

-- §3.1 State Tax Withholding (placeholder, agency configures for their state)
INSERT INTO public.personnel_form_templates (
  agency_id, name, description, url, form_category, doc_type_produced,
  is_required, producer_uploadable, display_order, is_active)
SELECT a.id, 'State Tax Withholding',
  'State income tax withholding form. Varies by state — agencies in states without income tax (FL, TX, WA, NV, TN, SD, WY, AK, NH) can deactivate this template. Configure the URL to point to your state DOR''s current withholding form (e.g., Georgia G-4, California DE 4, New York IT-2104).',
  'https://www.irs.gov/businesses/small-businesses-self-employed/state-links-1',
  'state_tax', 'state_tax', FALSE, TRUE, 15, TRUE
FROM public.agency a
WHERE NOT EXISTS (SELECT 1 FROM public.personnel_form_templates pft
                   WHERE pft.agency_id = a.id
                     AND (pft.name = 'State Tax Withholding' OR pft.doc_type_produced = 'state_tax'));

-- §3.2 Government-Issued Photo ID
INSERT INTO public.personnel_form_templates (
  agency_id, name, description, url, form_category, doc_type_produced,
  is_required, producer_uploadable, display_order, is_active)
SELECT a.id, 'Government-Issued Photo ID',
  'Photo identification for I-9 verification. Acceptable IDs include US or foreign passport, US driver''s license or state ID card, US military ID, or federal/state/local government-issued photo ID. Employee uploads a photo of the front of the ID.',
  'https://www.uscis.gov/i-9-central/form-i-9-acceptable-documents',
  'identity_verification', 'photo_id', TRUE, TRUE, 30, TRUE
FROM public.agency a
WHERE NOT EXISTS (SELECT 1 FROM public.personnel_form_templates pft
                   WHERE pft.agency_id = a.id
                     AND (pft.name = 'Government-Issued Photo ID' OR pft.doc_type_produced = 'photo_id'));

-- §3.3 Social Security Card
INSERT INTO public.personnel_form_templates (
  agency_id, name, description, url, form_category, doc_type_produced,
  is_required, producer_uploadable, display_order, is_active)
SELECT a.id, 'Social Security Card',
  'Original or certified copy of Social Security card for I-9 List C verification and payroll processing. If unavailable, employee may substitute a birth certificate + government-issued photo ID (see USCIS I-9 acceptable documents list).',
  'https://www.ssa.gov/ssnumber/',
  'identity_verification', 'ssn_card', TRUE, TRUE, 40, TRUE
FROM public.agency a
WHERE NOT EXISTS (SELECT 1 FROM public.personnel_form_templates pft
                   WHERE pft.agency_id = a.id
                     AND (pft.name = 'Social Security Card' OR pft.doc_type_produced = 'ssn_card'));

-- §3.4 Direct Deposit Authorization
INSERT INTO public.personnel_form_templates (
  agency_id, name, description, url, form_category, doc_type_produced,
  is_required, producer_uploadable, display_order, is_active)
SELECT a.id, 'Direct Deposit Authorization',
  'Employee authorization for direct deposit of wages. Requires routing + account number and either a voided check or bank verification letter. Agency should replace the URL with their own template or their payroll provider''s form (Gusto, ADP, Paychex).',
  'https://imaginary-farms.com/personnel-templates/direct-deposit',
  'payroll', 'direct_deposit', TRUE, TRUE, 50, TRUE
FROM public.agency a
WHERE NOT EXISTS (SELECT 1 FROM public.personnel_form_templates pft
                   WHERE pft.agency_id = a.id
                     AND (pft.name = 'Direct Deposit Authorization' OR pft.doc_type_produced = 'direct_deposit'));

-- §3.5 Benefits Election Form
INSERT INTO public.personnel_form_templates (
  agency_id, name, description, url, form_category, doc_type_produced,
  is_required, producer_uploadable, display_order, is_active)
SELECT a.id, 'Benefits Election Form',
  'Employee election of health, dental, vision, retirement, or other benefits offered by the agency. Even if the employee opts out of all benefits, they should sign an acknowledgment on file. Configure the URL to point to the agency''s benefits summary or broker portal.',
  'https://imaginary-farms.com/personnel-templates/benefits-election',
  'benefits_election', 'benefits_election', TRUE, TRUE, 60, TRUE
FROM public.agency a
WHERE NOT EXISTS (SELECT 1 FROM public.personnel_form_templates pft
                   WHERE pft.agency_id = a.id
                     AND (pft.name = 'Benefits Election Form' OR pft.doc_type_produced = 'benefits_election'));

-- §3.6 Employee Handbook Acknowledgment
INSERT INTO public.personnel_form_templates (
  agency_id, name, description, url, form_category, doc_type_produced,
  is_required, producer_uploadable, display_order, is_active)
SELECT a.id, 'Employee Handbook Acknowledgment',
  'Signed acknowledgment that the employee has received, read, and agrees to comply with the agency''s Employee Handbook. Best-practice: re-signed annually and on every material handbook update. Configure the URL to point to the agency''s current handbook version.',
  'https://imaginary-farms.com/personnel-templates/handbook-acknowledgment',
  'agency_policy', 'handbook_ack', TRUE, TRUE, 70, TRUE
FROM public.agency a
WHERE NOT EXISTS (SELECT 1 FROM public.personnel_form_templates pft
                   WHERE pft.agency_id = a.id
                     AND (pft.name = 'Employee Handbook Acknowledgment' OR pft.doc_type_produced = 'handbook_ack'));

-- §3.7 Social Media Policy Acknowledgment
INSERT INTO public.personnel_form_templates (
  agency_id, name, description, url, form_category, doc_type_produced,
  is_required, producer_uploadable, display_order, is_active)
SELECT a.id, 'Social Media Policy Acknowledgment',
  'Signed acknowledgment of the agency''s social media policy. Especially important for State Farm agents: policy should cover representation as an SF agent, use of trademarked SF branding on personal accounts, and confidentiality of client info. Configure the URL to point to the agency''s policy document.',
  'https://imaginary-farms.com/personnel-templates/social-media-policy',
  'agency_policy', 'social_media_ack', TRUE, TRUE, 80, TRUE
FROM public.agency a
WHERE NOT EXISTS (SELECT 1 FROM public.personnel_form_templates pft
                   WHERE pft.agency_id = a.id
                     AND (pft.name = 'Social Media Policy Acknowledgment' OR pft.doc_type_produced = 'social_media_ack'));

-- §3.8 Emergency Contact Form
INSERT INTO public.personnel_form_templates (
  agency_id, name, description, url, form_category, doc_type_produced,
  is_required, producer_uploadable, display_order, is_active)
SELECT a.id, 'Emergency Contact Form',
  'Employee''s emergency contact information — name, relationship, phone. Note: this is the OWNER-VISIBLE record. Employees can also maintain private emergency contacts through the Emergency Contacts module. Agency should keep at least one on file for workplace safety.',
  'https://imaginary-farms.com/personnel-templates/emergency-contact',
  'other', 'emergency_contact', TRUE, TRUE, 90, TRUE
FROM public.agency a
WHERE NOT EXISTS (SELECT 1 FROM public.personnel_form_templates pft
                   WHERE pft.agency_id = a.id
                     AND (pft.name IN ('Emergency Contact Form','Emergency Contact Information') OR pft.doc_type_produced = 'emergency_contact'));

-- §3.9 Annual Performance Review
INSERT INTO public.personnel_form_templates (
  agency_id, name, description, url, form_category, doc_type_produced,
  is_required, producer_uploadable, display_order, is_active)
SELECT a.id, 'Annual Performance Review',
  'Owner or manager completes and files after the annual review conversation. Not required (some agencies do reviews verbally or quarterly), and NOT producer-uploadable — this is an owner/manager-generated document. Configure the URL to point to the agency''s review template.',
  'https://imaginary-farms.com/personnel-templates/annual-review',
  'agency_policy', 'annual_review', FALSE, FALSE, 100, TRUE
FROM public.agency a
WHERE NOT EXISTS (SELECT 1 FROM public.personnel_form_templates pft
                   WHERE pft.agency_id = a.id
                     AND (pft.name IN ('Annual Performance Review','Annual Performance Review Form') OR pft.doc_type_produced = 'annual_review'));

-- §4. Log the seed operation into _install_provenance for observability.
--     This gives us a way to verify which install got the expanded baseline
--     and lets us diff later if we need to figure out which agencies still
--     need manual template curation.
--     Note: created_at defaults to now(), and overlay_version is optional
--     metadata that install tooling stamps when it applies the overlay.
INSERT INTO public._install_provenance (event_type, event_data)
SELECT
  'personnel_form_templates_baseline_seeded',
  jsonb_build_object(
    'migration', '109a',
    'templates_offered', 9,
    'baseline_version', 'v1.0',
    'source', 'client_install_backport',
    'agency_id', a.id,
    'agency_name', a.name,
    'templates_actually_present', (
      SELECT COUNT(*) FROM public.personnel_form_templates pft WHERE pft.agency_id = a.id
    )
  )
FROM public.agency a
WHERE NOT EXISTS (
  SELECT 1 FROM public._install_provenance ip
  WHERE ip.event_type = 'personnel_form_templates_baseline_seeded'
    AND (ip.event_data->>'agency_id')::uuid = a.id
);
