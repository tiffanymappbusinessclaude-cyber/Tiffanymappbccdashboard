# DASHBOARD_PATCH.md

**How Setup Claude splices Premium dashboard tiles into Base's `src/modules/Dashboard.jsx` during overlay apply.**

*Design-system reframing 2026-07-10 (v0.5.2): earlier revisions overstated a "Base uses inline styles, Premium uses Tailwind" divide. Base ships the shared design system across every module except Dashboard.jsx itself. Corrected in "Placement guidance" below.*

Mirrors the same manual-patch pattern as `nav-patch/NAV_ITEMS.premium.js` (BCCApp.jsx modifications) and `runner-patch/RUNNER_PATCH.md` (automation-runner modifications). Setup Claude reads this document once, plans the diff against the client's actual Dashboard.jsx, applies it carefully, and verifies.

---

## What ships in this directory

- `PREMIUM_TILES.premium.jsx` — reference file with exported import block + tile JSX snippets. Not copied into the client repo verbatim; content is spliced into `src/modules/Dashboard.jsx`.
- `DASHBOARD_PATCH.md` — this file.

---

## Prerequisites

Before applying this patch:

1. The Premium §4 PTO migration `107a_pto_schema.sql` (or its containing module migration) is applied to the client's Supabase. Verify:
   ```sql
   SELECT to_regclass('public.pto_requests');   -- expect: pto_requests (non-null)
   SELECT to_regclass('public.pto_balances');   -- expect: pto_balances (non-null)
   ```
2. The Premium JSX modules have already been copied per Step 4 of `OVERLAY_APPLY.md` — specifically `webapp-modules/src/components/PTOPendingTile.jsx` is present at the client repo's `src/components/PTOPendingTile.jsx`.
3. The client's Dashboard.jsx has not been hand-edited (per the "Per-client customization is forbidden" clause in the design doc supplement 2026-07-09). If it has, stop and investigate.

If any prerequisite is missing, stop.

---

## The patch — two edits

### Edit 1: Add the import

**Where:** Top of `src/modules/Dashboard.jsx`, alongside the existing imports.

**Content:** the contents of `PREMIUM_DASHBOARD_IMPORT_BLOCK` from `PREMIUM_TILES.premium.jsx`. Currently:

```jsx
import PTOPendingTile from "../components/PTOPendingTile.jsx";
```

Order relative to other imports is aesthetic. Grouping with a section-comment `// Premium overlay dashboard tiles` is preferred.

### Edit 2: Splice the tile into the render

**Where:** In the main render section of Dashboard.jsx — anywhere the tile fits the client's dashboard layout.

**Content:** the tile JSX from `PREMIUM_DASHBOARD_TILES.pto_pending`:

```jsx
{/* Premium §4 PTO — Pending requests tile. */}
<PTOPendingTile onNavigate={() => onNavigate && onNavigate("pto")} />
```

**Placement guidance:**

- **Base ships the shared design system** (`--if-*` CSS variables + `.if-card` / `.if-button` utilities) and every other Base module uses it. Premium's `PTOPendingTile` also uses `if-card`. **The one exception is Base's `Dashboard.jsx` itself**, which still uses legacy inline `style={{}}` and a local `<Card>` component. That's Base tech debt scoped to that one file — not a systemic Premium/Base mismatch. Practical placement guidance: adjacent to Base's cash-flow or production summaries the Premium tile will look visually distinct (rounded corners, subtle shadow, Tailwind spacing) because it renders through the shared design system while the neighboring Base cards do not yet. Prefer a dedicated "Team Operations" or "Personnel" section, or place near the bottom of the main content flow. When Base's Dashboard.jsx is eventually refactored onto the shared tokens, this placement caveat goes away and Premium tiles can sit alongside Base cards without visual seams.
- `PTOPendingTile` self-hides via `return null` when `count === 0` and there's no error. Placement is therefore forgiving — a placement that's "too prominent" costs nothing visually when there's nothing to show.
- `onNavigate` is a prop that Dashboard.jsx already receives from BCCApp.jsx (see `BCCApp.jsx` line ~175: `<Dashboard onNavigate={onNavigate} />`). Reuse it directly; do NOT introduce a new state hook inside Dashboard.jsx to handle navigation.

If the client's Dashboard.jsx has a clear grid or flex container for tiles, drop the JSX inside that container. If tiles are laid out ad-hoc via inline styles, insert the JSX where it reads naturally in the render.

---

## Verification after patch

1. **Rebuild the frontend:**
   ```bash
   cd <client-repo>
   npm run build
   ```
   No errors expected. If TypeScript/ESLint complains about a missing import, verify the file path in the added import line (`../components/PTOPendingTile.jsx`) matches where the JSX file was copied in Step 4.

2. **Deploy the built assets** per the client's normal deploy pipeline.

3. **Smoke test — empty state:**
   - Log in as any user with no pending PTO requests to their name (owner with an empty queue works fine).
   - Load the dashboard.
   - Expected: the PTOPendingTile is NOT visible (self-hidden at count=0).

4. **Smoke test — populated state:**
   - Log in as a producer.
   - Submit one PTO request (via the PTO module → PTOMine).
   - Return to the dashboard.
   - Expected: the tile renders with "1 request awaiting decision" and is clickable.
   - Click the tile → navigates to PTO module (which routes to PTOMine for a producer).
   - Log in as owner, dashboard now shows the same 1-pending count (queue view), click → routes to PTOAdmin's Pending Queue tab.

5. **Smoke test — Producer Isolation:**
   - Two producers each with a pending request; the tile shows count=1 for each (their own only), count=2 for the owner. Verifies RLS scopes correctly.

---

## Rollback

If the patch causes issues, revert `src/modules/Dashboard.jsx` to its pre-patch state (git checkout) and rebuild. The PTOPendingTile.jsx component file itself can stay in `src/components/` — it's inert without an importer.
