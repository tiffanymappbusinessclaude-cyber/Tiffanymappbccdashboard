/**
 * FilterPill — toggleable filter chip.
 * Props:
 *   active   — boolean
 *   onClick  — click handler
 *   children — pill label
 */
export default function FilterPill({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "4px 12px",
        fontSize: 11,
        fontWeight: 600,
        borderRadius: 999,
        border: active ? "1px solid #1E3A5F" : "1px solid #E2E8F0",
        background: active ? "var(--accent-navy)" : "white",
        color: active ? "white" : "var(--text-secondary)",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}
