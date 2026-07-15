# nav-patch/

Modifications to `BCCApp.jsx` in the client repo that the overlay ships as reference patches.

## Files

- `NAV_ITEMS.premium.js` — 10 Premium nav entries, module imports, router branches, and new icon paths. Setup Claude reads this file and applies the diffs to the client's `BCCApp.jsx` manually during overlay apply.

## Why a manual patch instead of an auto-applied diff

`BCCApp.jsx` is a live JSX file with per-agency customizations (agency name, mock data, tokens). A blind text diff can break syntax. Setup Claude reads the client's current `BCCApp.jsx`, plans the diff based on `NAV_ITEMS.premium.js`, applies it carefully, and re-reads to verify. This is a five-minute manual operation done right rather than a scriptable one that breaks half the time.
