-- bcc-deepdive/classification-rules-seed — 2026-07-24T04:50Z
-- Follow-on to P1: 187 suspense JEs need a rules layer so future txns
-- auto-classify. This seeds 28 rules covering the highest-frequency
-- patterns observed in bank_transactions + credit_transactions.
-- Alignment: CPA classifications from cpa_general_ledger were consulted;
-- ambiguous cases (personal, SBA principal/interest split, family
-- transfers) are left OUT — those stay in suspense for Julie's review.
--
-- Priority scheme: 10-49 = high-specificity (statement summary rows +
-- ADP + intra-account); 50-79 = clear vendor patterns; 100 = default
-- (reserved for future).
--
-- Additive only. Rollback: DELETE FROM classification_rules WHERE
-- description LIKE 'bcc-deepdive-seed%'.

INSERT INTO public.classification_rules
  (agency_id, source, match_pattern, amount_sign, rule_action, target_account_code, priority, is_active, description)
VALUES
-- ==========================================================
-- BANK SKIP RULES (avoid double-counting)
-- ==========================================================
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','bank','STATE FARM','positive','skip',NULL,10,true,'bcc-deepdive-seed: SF commission deposits already booked via comp_recap; bank side = duplicate'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','bank','ADP WAGE PAY','negative','skip',NULL,15,true,'bcc-deepdive-seed: ADP payroll cash movement; expense side is in payroll_detail / payroll_gl_writer'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','bank','ADP Tax','negative','skip',NULL,15,true,'bcc-deepdive-seed: ADP tax remittance; liability side handled by payroll_detail'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','bank','ADP PAYROLL FEES','negative','reclassify','6403',50,true,'bcc-deepdive-seed: ADP processing fees -> 6403 Payroll Processing Fees'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','bank','statement summary','any','skip',NULL,20,true,'bcc-deepdive-seed: bank statement summary metadata row, not a txn'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','bank','Online Banking transfer','any','skip',NULL,25,true,'bcc-deepdive-seed: intra-account transfer (both legs already in bank_transactions)'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','bank','BUSINESS CARD Bill Payment','negative','skip',NULL,25,true,'bcc-deepdive-seed: CC payment out of bank; CC side already tracked in credit_accounts'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','bank','SBA EIDL LOAN','negative','skip',NULL,30,true,'bcc-deepdive-seed: SBA loan payment mixed principal/interest — needs manual split; escalate to Julie CPA'),
-- ==========================================================
-- BANK RECLASSIFY RULES (clear vendors)
-- ==========================================================
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','bank','JETBLUE','negative','reclassify','6511',60,true,'bcc-deepdive-seed: JetBlue -> 6511 Travel'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','bank','DELTA AIR','negative','reclassify','6511',60,true,'bcc-deepdive-seed: Delta Air Lines -> 6511 Travel'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','bank','NEOPOST','negative','reclassify','6502',60,true,'bcc-deepdive-seed: Neopost (postage meter) -> 6502 Postage & Shipping'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','bank','PUBLIX','negative','reclassify','6501',60,true,'bcc-deepdive-seed: Publix (office breakroom) -> 6501 Office Supplies per CPA classification'),
-- ==========================================================
-- CC SKIP RULES (statement metadata + payments received)
-- ==========================================================
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','credit_card','statement summary','any','skip',NULL,20,true,'bcc-deepdive-seed: CC statement summary metadata row'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','credit_card','ONLINE PAYMENT - THANK YOU','any','skip',NULL,25,true,'bcc-deepdive-seed: CC payment received from bank (bank side handled by skip rule above)'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','credit_card','AMEX Airline Fee Reimbursement','any','skip',NULL,30,true,'bcc-deepdive-seed: AmEx airline fee reimbursement (offset to previously-booked travel)'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','credit_card','CASH APP','any','skip',NULL,35,true,'bcc-deepdive-seed: CashApp payment — personal/business ambiguity, needs Julie CPA review'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','credit_card','STATE FARM INSURANCE','any','skip',NULL,35,true,'bcc-deepdive-seed: SF Insurance charge on CC — may be E&O or personal; defer to Julie CPA'),
-- ==========================================================
-- CC RECLASSIFY RULES (clear vendors, matches CPA GL)
-- ==========================================================
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','credit_card','Interest Charged','positive','reclassify','6703',40,true,'bcc-deepdive-seed: CC interest charges -> 6703 Interest Expense (matches CPA "Interest Paid" section)'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','credit_card','MEDIAALPHA','positive','reclassify','6201',50,true,'bcc-deepdive-seed: MediaAlpha lead-gen -> 6201 Digital Advertising'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','credit_card','QUOTEWIZARD','positive','reclassify','6201',50,true,'bcc-deepdive-seed: QuoteWizard lead-gen -> 6201 Digital Advertising'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','credit_card','SMARTFINANCIAL','positive','reclassify','6201',50,true,'bcc-deepdive-seed: SmartFinancial.com lead-gen -> 6201 Digital Advertising'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','credit_card','BUTLER/TILL','positive','reclassify','6201',50,true,'bcc-deepdive-seed: Butler/Till marketing agency -> 6201 Digital Advertising'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','credit_card','DIGITAL FLOW SOLUTIONS','positive','reclassify','6301',55,true,'bcc-deepdive-seed: Digital Flow Solutions (website) -> 6301 Software Subscriptions'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','credit_card','AMAZON','positive','reclassify','6501',60,true,'bcc-deepdive-seed: Amazon (marketplace/direct) -> 6501 Office Supplies per CPA classification'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','credit_card','READYREFRESH','positive','reclassify','6501',60,true,'bcc-deepdive-seed: ReadyRefresh water delivery -> 6501 Office Supplies (office pantry)'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','credit_card','DELTA AIR LINES','positive','reclassify','6511',60,true,'bcc-deepdive-seed: Delta Air Lines -> 6511 Travel'),
('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065','credit_card','JETBLUE','positive','reclassify','6511',60,true,'bcc-deepdive-seed: JetBlue -> 6511 Travel');
