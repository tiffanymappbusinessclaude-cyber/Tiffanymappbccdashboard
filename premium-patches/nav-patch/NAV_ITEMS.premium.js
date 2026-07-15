// =============================================================
// NAV_ITEMS.premium.js
// -------------------------------------------------------------
// Overlay: bcc-premium-overlay v0.5.8 UI
// Purpose: Nav entries to inject into the existing NAV_ITEMS
//          array in BCCApp.jsx.
//
// v0.5.8 UI SCOPE
// -------------------------------------------------------------
// This overlay version ships TEN Premium modules — the full
// Premium tier surface. v0.5.8 UI is the last increment before
// the v1.0 tag ceremony.
//
//   * §4    PTO                 (shipped v0.5.1-rc1, hours-convention
//                                polish landed v0.5.2)
//   * §4.1  Time Tracking       (shipped v0.5.6 UI — Module 01 —
//                                backend v0.5.6, UI v0.5.6 UI)
//   * §4.2  Sales Activity      (shipped v0.5.5 UI — Module 02)
//   * §4.3  Scoreboard          (shipped v0.5.7 UI — Module 03 —
//                                backend shipped v0.5.7, UI shipped
//                                v0.5.7 UI companion. Tier
//                                differentiator surface: goals,
//                                celebrations, leaderboard.)
//   * §4.5  Handbook            (shipped v0.5.4 — Module 05)
//   * §4.6  Benefits            (shipped v0.5.4 — Module 06)
//   * §4.7  Personnel Files     (NEW in v0.5.8 UI — Module 07 —
//                                backend shipped v0.5.8, UI shipped
//                                v0.5.8 UI companion. Extreme-PII
//                                storage: Drive-via-Composio.)
//   * §4.8  Licenses            (shipped v0.5.3 — Module 08)
//   * §4.9  Milestones          (shipped v0.5.2 — Module 09)
//   * §4.10 Emergency Contacts  (shipped v0.5.3 — Module 10)
//
// The ROADMAP constant is now empty — every §4 module ships in
// this overlay version. This closes the Premium tier surface
// and is the immediate precondition for the v1.0 tag ceremony.
// Setup Claude at v0.5.8 UI install time applies ONLY:
//   * PREMIUM_NAV_ENTRIES         (ten entries)
//   * PREMIUM_IMPORT_BLOCK        (twelve imports)
//   * PREMIUM_ROUTER_BLOCK        (ten cases)
//   * PREMIUM_ICON_PATHS          (ten icons)
//
// Applying the (now empty) ROADMAP constant would be a no-op.
// =============================================================

// -------------------------------------------------------------
// PREMIUM_NAV_ENTRIES — the ACTIVE set for v0.5.8 UI
// -------------------------------------------------------------
// Note on ordering (updated for v0.5.8 UI): the coaching-signal
// trio (Time → Activity → Scoreboard) still sits together as
// positions 2-4. Personnel Files (§4.7) slots into the HR /
// People cluster between Benefits and Milestones — after the
// "policies + comp" modules (Handbook, Benefits) and before the
// "recognition + compliance" modules (Milestones, Licenses,
// Emergency Contacts). Personnel Files is the compliance
// archive; positioning it in the middle of the HR grouping
// signals its role as the master employee record.
export const PREMIUM_NAV_ENTRIES = [
  { id: "pto",                label: "PTO",                 icon: "calendar",     roles: ["owner", "manager", "staff"] },
  { id: "time",               label: "Time Tracking",       icon: "clock",        roles: ["owner", "manager", "staff"] },
  { id: "activity",           label: "Sales Activity",      icon: "trending",     roles: ["owner", "manager", "staff"] },
  { id: "scoreboard",         label: "Scoreboard",          icon: "bar-chart",    roles: ["owner", "manager", "staff"] },
  { id: "handbook",           label: "Handbook",            icon: "book-open",    roles: ["owner", "manager", "staff"] },
  { id: "benefits",           label: "Benefits",            icon: "layers",       roles: ["owner", "manager", "staff"] },
  { id: "personnel_files",    label: "Personnel Files",     icon: "user-lock",    roles: ["owner", "manager", "staff"] },
  { id: "milestones",         label: "Milestones",          icon: "gift",         roles: ["owner", "manager", "staff"] },
  { id: "licenses",           label: "Licenses",            icon: "shield-check", roles: ["owner", "manager", "staff"] },
  { id: "emergency_contacts", label: "Emergency Contacts",  icon: "phone-alert",  roles: ["owner", "manager", "staff"] },
];

// -------------------------------------------------------------
// PREMIUM_NAV_ENTRIES_ROADMAP — REFERENCE ONLY (do NOT apply)
// -------------------------------------------------------------
// v0.5.8 UI ships every §4 Premium module — the roadmap is empty.
// The constant is retained (as an empty array) so downstream
// tooling that reads this file without conditional exports
// doesn't break.
export const PREMIUM_NAV_ENTRIES_ROADMAP = [];

// -------------------------------------------------------------
// PREMIUM_IMPORT_BLOCK — v0.5.8 UI imports
// -------------------------------------------------------------
export const PREMIUM_IMPORT_BLOCK = `
// Premium overlay modules (added by bcc-premium-overlay v0.5.1+ / v0.5.2 / v0.5.3 / v0.5.4 / v0.5.5 UI / v0.5.6 UI / v0.5.7 UI / v0.5.8 UI)
import PTOAdmin               from "./src/modules/PTOAdmin.jsx";
import PTOMine                from "./src/modules/PTOMine.jsx";
import TimeTracking           from "./src/modules/TimeTracking.jsx";
import SalesActivity          from "./src/modules/SalesActivity.jsx";
import Scoreboard             from "./src/modules/Scoreboard.jsx";
import Handbook               from "./src/modules/Handbook.jsx";
import Benefits               from "./src/modules/Benefits.jsx";
import PersonnelFiles         from "./src/modules/PersonnelFiles.jsx";
import Milestones             from "./src/modules/Milestones.jsx";
import Licenses               from "./src/modules/Licenses.jsx";
import EmergencyContacts      from "./src/modules/EmergencyContacts.jsx";
import EmergencyContactsMine  from "./src/modules/EmergencyContactsMine.jsx";
`;

// -------------------------------------------------------------
// PREMIUM_ROUTER_BLOCK — v0.5.8 UI router
// -------------------------------------------------------------
// Role-aware dispatch pattern per design doc Appendix B.5.
//
// - PTO: two-file split (PTOAdmin for owner/manager, PTOMine for producer).
//   Server RPC enforces authorization; UI split is for clarity, not
//   security.
//
// - Time Tracking: single-file (§4.1) that renders ProducerSurface OR
//   OwnerManagerSurface based on role check on useMyProfile().role.
//   Manager gate defaults TRUE per migration 101 (documented B.11
//   deviation).
//
// - Sales Activity: single-file (§4.2) with PII compliance guardrails.
//   Manager gate defaults TRUE per migration 102 (documented B.11
//   deviation).
//
// - Scoreboard: single-file (§4.3). Manager gate defaults FALSE per
//   migration 103 (CANONICAL B.11 — first Premium module to hold the
//   canonical default). All motion via requestAnimationFrame + CSS
//   transitions (Framer Motion not in Base bundle).
//
// - Handbook: single-file (§4.5). Manager gate defaults TRUE per
//   migration 105 (documented B.11 deviation).
//
// - Benefits: single-file (§4.6). Manager gate defaults FALSE
//   (canonical B.11 — comp-adjacent PII).
//
// - Personnel Files: single-file (§4.7). Manager gate defaults FALSE
//   per migration 109 (CANONICAL B.11 — SECOND Premium module in a
//   row to hold canonical default after Scoreboard). Q5 LAYERED
//   MANAGER GATE: global gate PLUS per-employee grants via the
//   personnel_file_manager_grants table. Extreme-PII storage model:
//   file bytes live in the agent's Google Drive at
//   /BCC/HR/Personnel Records/[staff_id]/ via Composio's
//   GOOGLEDRIVE_UPLOAD_FROM_URL; the database stores drive_file_id
//   + metadata only. INSTALL PREREQ: Composio Google Drive
//   connection must be active AND settings.drive_composio_connected
//   must be 'true' before this module renders working UI (blocking
//   gate shown otherwise). Every reveal is logged to
//   personnel_document_access_log; producers cannot see who
//   accessed their file (Q4=B ratification, traditional HR model).
//
// - Milestones: single-file (public-recognition surface).
//
// - Licenses: single-file (RLS-scoped; SECURITY DEFINER RPCs re-check
//   authorization).
//
// - Emergency Contacts: two-file split (owner/manager get reveal flow;
//   producer gets own-CRUD).
export const PREMIUM_ROUTER_BLOCK = `
    case "pto":
      return currentUserRole === "owner" || currentUserRole === "manager"
        ? <PTOAdmin />
        : <PTOMine />;
    case "time":
      return <TimeTracking />;
    case "activity":
      return <SalesActivity />;
    case "scoreboard":
      return <Scoreboard />;
    case "handbook":
      return <Handbook />;
    case "benefits":
      return <Benefits />;
    case "personnel_files":
      return <PersonnelFiles />;
    case "milestones":
      return <Milestones />;
    case "licenses":
      return <Licenses />;
    case "emergency_contacts":
      return currentUserRole === "owner" || currentUserRole === "manager"
        ? <EmergencyContacts />
        : <EmergencyContactsMine />;
`;

// -------------------------------------------------------------
// PREMIUM_ICON_PATHS — v0.5.8 UI
// -------------------------------------------------------------
// Icons that Base does NOT already ship. Base ships: grid, dollar,
// brain, map, book, shield, zap, share, check, bell, folder, users,
// message, settings.
// Overlay adds: calendar, clock, trending, bar-chart, book-open,
// layers, gift, shield-check, phone-alert, user-lock (NEW v0.5.8 UI).
export const PREMIUM_ICON_PATHS = {
  calendar:       `<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>`,
  clock:          `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`,
  trending:       `<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>`,
  "bar-chart":    `<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>`,
  "book-open":    `<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>`,
  layers:         `<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>`,
  gift:           `<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>`,
  "shield-check": `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>`,
  "phone-alert":  `<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/><line x1="18" y1="2" x2="18" y2="8"/><line x1="18" y1="10" x2="18" y2="10.01"/>`,
  "user-lock":    `<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2"/><rect x="15" y="12" width="8" height="7" rx="1"/><path d="M17 12v-2a2 2 0 1 1 4 0v2"/>`,
};

// -------------------------------------------------------------
// Notes for Setup Claude at apply time (v0.5.8 UI)
// -------------------------------------------------------------
// 1. APPLY: PREMIUM_NAV_ENTRIES + PREMIUM_IMPORT_BLOCK +
//    PREMIUM_ROUTER_BLOCK + PREMIUM_ICON_PATHS
// 2. DO NOT APPLY: PREMIUM_NAV_ENTRIES_ROADMAP (now empty)
// 3. Icons already in Base (grid, dollar, brain, map, book,
//    shield, zap, share, check, bell, folder, users, message,
//    settings) are NOT duplicated in PREMIUM_ICON_PATHS.
// 4. Upgrade paths from earlier overlay versions:
//    * v0.5.7 UI → v0.5.8 UI: add personnel_files entry
//      (positioned between benefits and milestones),
//      PersonnelFiles import (positioned between Benefits and
//      Milestones), router case "personnel_files", and the
//      user-lock icon path. Personnel Files sits inside the HR
//      grouping — it's the compliance archive that Handbook,
//      Benefits, Milestones, Licenses, and Emergency Contacts
//      all peek into for context.
//    * v0.5.6 UI → v0.5.8 UI: add scoreboard + personnel_files
//      entries and their imports/router cases/icons in a single
//      Setup Claude pass.
//    * v0.5.5 UI → v0.5.8 UI: add time + scoreboard +
//      personnel_files. Reorder existing entries per v0.5.8 UI
//      ordering.
//    * v0.5.4 → v0.5.8 UI: add time + activity + scoreboard +
//      personnel_files entries and their supporting bits.
//    * v0.5.3 → v0.5.8 UI: add time + activity + handbook +
//      benefits + scoreboard + personnel_files entries.
//    * v0.5.2 → v0.5.8 UI: add time + activity + handbook +
//      benefits + scoreboard + personnel_files + licenses +
//      emergency_contacts entries.
//    * v0.5.1 → v0.5.8 UI: full replay of all 9 non-PTO adds.
// 5. Nav ID cross-references: Personnel Files uses nav id
//    "personnel_files" — matches the underlying personnel_*
//    table prefix from migration 109. Automation recipes for
//    Personnel Files can deep-link via
//    source_module="personnel_files" if needed. The historical
//    ROADMAP placeholder id from v0.5.7 was renamed on ship to
//    align with the DB schema.
// 6. INSTALL PREREQ FOR PERSONNEL FILES: Setup Claude MUST verify
//    that (a) the agent's Google Drive is connected via Composio,
//    (b) COMPOSIO_API_KEY and COMPOSIO_CONNECTED_ACCOUNT_ID
//    secrets are set on the client's Supabase project via
//    `supabase secrets set`, (c) private Storage bucket named
//    `personnel-uploads-temp` exists with a lifecycle policy
//    aging out objects older than 24 hours, AND (d) the
//    settings.drive_composio_connected row is written as 'true'.
//    Without all four, the Personnel Files UI renders a blocking
//    gate instead of the working surface. This is by design —
//    the module handles the agency's most sensitive employee
//    data and cannot silently degrade.
// 7. Personnel Files ships an Edge Function alongside its UI:
//    supabase/functions/personnel-upload/index.ts. Setup Claude
//    MUST deploy it via `supabase functions deploy personnel-upload`
//    as part of the install script. The UI's UploadDocumentModal
//    invokes it via supabase.functions.invoke("personnel-upload").
