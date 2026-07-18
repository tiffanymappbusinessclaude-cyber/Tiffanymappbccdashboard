# BCC Training Guide — Placeholder Legend

Variables to substitute per client at install time. Do a find-and-replace pass on `BCC_Training_Guide_TEMPLATE.html` before delivery.

| Placeholder | Example value | Where it's used |
|---|---|---|
| `{{AGENCY_NAME}}` | Michael Grant Agency | Cover eyebrow, closing stamp |
| `{{AGENT_FULL_NAME}}` | Michael Grant | Appendix People table |
| `{{LEGAL_ENTITY_NAME}}` | Michael Grant Insurance Agency, Inc. | Appendix People table |
| `{{ENTITY_TYPE}}` | S-Corp | Appendix — agency structure line |
| `{{AGENT_CODE}}` | 11-2923 | Appendix — agency structure line |
| `{{CITY}}` | Tucker | Appendix + closing stamp |
| `{{STATE}}` | GA | Appendix + closing stamp |
| `{{CPA_NAME}}` | Johann J. Reckley | Appendix People table |
| `{{CPA_FIRM}}` | JJR & Associates LLC | Appendix People table |
| `{{VERCEL_APP_URL}}` | mgrantbccdashboard.vercel.app | SVG diagram + Getting Started + Appendix |
| `{{SUPABASE_PROJECT_URL}}` | brozvvsawwpxitvvkfou.supabase.co | Appendix Live Surfaces |
| `{{GITHUB_REPO_URL}}` | github.com/mgrant-claude-ship-it/mgrantbccdashboard | Appendix Live Surfaces |
| `{{SERVICE_MAILBOX}}` | insuredbymgrant.claude@gmail.com | Part 07 flow-step 1, Setup Wizard step 4, Appendix |
| `{{AGENCY_UUID}}` | 3bab2b3f-da78-42d6-a793-3d2a31cbf18b | Appendix System Identifiers |
| `{{COMPOSIO_PROJECT_ID}}` | pr_eisOqf59Gdua | Appendix System Identifiers |
| `{{SMVC_PC_RATE}}` | 10.00% | Appendix System Identifiers |
| `{{BLENDED_RATE}}` | 9.00% | Appendix System Identifiers |
| `{{LAPSE_RATE}}` | 10.00% | Appendix System Identifiers |
| `{{DELIVERY_MONTH_YEAR}}` | July 2026 | Cover meta + closing stamp |

## Notes

- **Case sensitivity**: All placeholders are `{{UPPER_SNAKE_CASE}}`. Match exactly.
- **Rate fields**: Include the `%` symbol in your replacement value (e.g. `10.00%` not `10.00`).
- **URLs in `<code>` blocks**: Keep them as-is; don't wrap in additional formatting.
- **Verification**: After substitution, `grep "{{" BCC_Training_Guide_<client>.html` should return zero matches.

## Suggested delivery workflow

1. Duplicate `BCC_Training_Guide_TEMPLATE.html` → `BCC_Training_Guide_<AgentLastName>.html`
2. Populate a values sheet for the client (all 19 placeholders above)
3. Run find/replace pass
4. `grep "{{"` to verify zero remaining placeholders
5. Open in browser → File → Print → Save as PDF (print CSS is optimized for letter size, 0.75in top/bottom, 0.65in side margins)
6. Deliver both `.html` and `.pdf` to the client via Drive
