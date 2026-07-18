/**
 * SearchInput — text input with search icon, brand-styled focus ring.
 * IMPORTANT: onChange is called with the VALUE STRING, not an event object.
 *
 * Props:
 *   value       — string
 *   onChange    — (value: string) => void
 *   placeholder — string (optional)
 */
export default function SearchInput({ value, onChange, placeholder = "Search…" }) {
  return (
    <div style={{
      position: "relative",
      width: "100%",
    }}>
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 12,
          top: "50%",
          transform: "translateY(-50%)",
          color: "var(--text-quaternary)",
          fontSize: 14,
          pointerEvents: "none",
          lineHeight: 1,
        }}
      >
        {"\u{1F50D}"}
      </span>
      <input
        type="text"
        value={value ?? ""}
        onChange={(e) => onChange && onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%",
          height: 40,
          padding: "0 12px 0 36px",
          border: "1px solid #E2E8F0",
          borderRadius: 8,
          fontSize: 14,
          color: "var(--text-primary)",
          background: "var(--bg-card)",
          outline: "none",
          boxSizing: "border-box",
          fontFamily: "inherit",
          transition: "border-color 120ms ease, box-shadow 120ms ease",
        }}
        onFocus={(e) => {
          e.target.style.borderColor = "var(--accent-navy)";
          e.target.style.boxShadow = "0 0 0 3px rgba(30,58,95,0.12)";
        }}
        onBlur={(e) => {
          e.target.style.borderColor = "var(--border-subtle)";
          e.target.style.boxShadow = "none";
        }}
      />
    </div>
  );
}
