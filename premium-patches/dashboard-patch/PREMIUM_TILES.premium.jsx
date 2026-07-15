// =============================================================
// PREMIUM_TILES.premium.jsx
// -------------------------------------------------------------
// Overlay: bcc-premium-overlay v0.5.1-rc1
// Purpose: Premium dashboard tiles to inject into the existing
//          src/modules/Dashboard.jsx main render section.
//
// Setup Claude at install time:
//   1. Opens the client repo's src/modules/Dashboard.jsx
//   2. Adds the imports below at the top of the file, alongside
//      the existing imports
//   3. Splices the JSX tiles into the main content grid — see
//      DASHBOARD_PATCH.md for insertion guidance
//   4. Each tile is self-hiding: if it has nothing to show
//      (e.g., zero pending items, no expiring licenses), it
//      renders null. Placement is therefore forgiving.
//
// This file mirrors the shape of nav-patch/NAV_ITEMS.premium.js:
// exported string blocks that Setup Claude splices manually.
// =============================================================

// -------------------------------------------------------------
// IMPORTS — add these to the top of src/modules/Dashboard.jsx
// -------------------------------------------------------------
// The Dashboard.jsx file already has an onNavigate prop passed
// down from BCCApp.jsx (see BCCApp.jsx line ~175:
// `<Dashboard onNavigate={onNavigate} />`). Reuse that prop for
// tile navigation — do NOT introduce a new state hook.
// -------------------------------------------------------------
export const PREMIUM_DASHBOARD_IMPORT_BLOCK = `
// Premium overlay dashboard tiles (added by bcc-premium-overlay v0.5.1+)
import PTOPendingTile from "../components/PTOPendingTile.jsx";
`;

// -------------------------------------------------------------
// TILES — JSX snippets to inject into Dashboard.jsx render
//
// Each tile block below is a self-contained JSX fragment.
// Setup Claude drops each into the dashboard's main content
// area at a location that makes sense given the client's
// current dashboard structure.
//
// Guidance for placement:
//   • Base's Dashboard.jsx uses inline styles + a local <Card>
//     component. Premium tiles use Tailwind + the shared `if-card`
//     utility class. Visual consistency across the two design
//     systems is a v0.6 concern; for now, prefer placing Premium
//     tiles in their own logical section (e.g., "Team Operations")
//     rather than intermixed with cash-flow or production tiles.
//   • Self-hiding tiles are safe to place anywhere they fit — a
//     tile that has nothing to show renders null and takes no
//     visual space.
//   • Pass `onNavigate` if the tile supports it — Dashboard.jsx
//     receives onNavigate as a prop from BCCApp.jsx.
// -------------------------------------------------------------
export const PREMIUM_DASHBOARD_TILES = {
  // §4 PTO — Pending requests tile.
  // Owner/authorized manager see count across all staff.
  // Producer sees own pending count. Both scopes are enforced
  // server-side via RLS on pto_requests (see migration 107a).
  // Self-hides when count === 0.
  pto_pending: `
{/* Premium §4 PTO — Pending requests tile.
    Owner/manager see all, producers see own. Self-hides at count=0.
    Clicking navigates to the PTO module (id "pto"), which routes
    to PTOAdmin for owner/manager and PTOMine for producer. */}
<PTOPendingTile onNavigate={() => onNavigate && onNavigate("pto")} />
`,

  // Future v0.5.2+ tiles (planned):
  //   handbook_unsigned:      unsigned handbook acknowledgments
  //   license_expiring_soon:  producer licenses expiring in <60 days
  //   milestones_this_week:   birthdays + anniversaries this week
  //   docs_awaiting_review:   personnel files awaiting owner action
};

// -------------------------------------------------------------
// Notes for setup Claude at apply time
// -------------------------------------------------------------
// 1. If the client's Dashboard.jsx has been hand-edited (per-client
//    customization is forbidden by the design doc supplement
//    2026-07-09) — stop and investigate. Do not paper over
//    per-client Dashboard changes with more Premium tiles.
//
// 2. If a prior overlay apply already inserted PTOPendingTile
//    (v0.5.1 or later), do not duplicate it. Check for the exact
//    import line before inserting.
//
// 3. Dashboard.jsx renders inside an ErrorBoundary at the BCCApp
//    router level. If PTOPendingTile throws for any reason (e.g.,
//    Supabase not yet initialized, RLS misconfiguration), only that
//    tile's section boundary catches — the rest of the dashboard
//    still renders.
//
// 4. The tile calls Supabase directly using the client's own
//    supabase.js module. No cross-agency query risk; the RLS
//    policies from migration 107a enforce the count scope.
