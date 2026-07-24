/**
 * StatCard — small KPI tile used by premium overlay modules.
 * Props:
 *   label    — string (top heading, muted)
 *   value    — string | number (large main number)
 *   sublabel — string (small caption below)
 *   tone     — "positive" | "warning" | "negative" | undefined (neutral)
 *   loading  — boolean (skeleton state)
 *   icon     — lucide-react icon component (optional, top-right)
 *   delta    — string | number | { diff, pct } (optional, small trend indicator)
 *
 * Defensive delta handling (added 2026-07-17 Session 4d):
 *   TimeTracking.jsx and other modules historically returned object-shaped
 *   deltas like { diff, pct } — rendering those directly as JSX children
 *   triggers React error #31 ("Objects are not valid as a React child").
 *   StatCard now normalizes object deltas to a display string internally
 *   so callers cannot crash the render tree by returning the wrong shape.
 */
function renderDelta(delta) {
  if (delta == null) return null;
  // Plain string or number — safe to render as-is.
  if (typeof delta === "string" || typeof delta === "number") return delta;
  // Object shape { diff, pct } — format as "+3.5 (+12%)"
  if (typeof delta === "object" && delta.diff != null && delta.pct != null) {
    const d = Number(delta.diff);
    const p = Number(delta.pct);
    const sign = d >= 0 ? "+" : "";
    return `${sign}${d.toFixed(1)} (${sign}${p}%)`;
  }
  // React element (already a valid JSX child) — pass through.
  if (typeof delta === "object" && delta.$$typeof) return delta;
  // Unknown object shape — don't crash, drop silently. Callers get a
  // console warning to fix their contract at the source.
  if (typeof console !== "undefined" && console.warn) {
    console.warn("StatCard: dropped non-renderable delta prop", delta);
  }
  return null;
}

export default function StatCard({
  label,
  value,
  sublabel,
  tone,
  loading = false,
  icon: Icon,
  delta,
}) {
  const toneColor = {
    positive: "var(--success)",
    warning:  "var(--warning)",
    negative: "var(--danger)",
  }[tone] || "var(--accent-navy)";

  const accentBg = {
    positive: "var(--success-bg)",
    warning:  "var(--warning-bg)",
    negative: "var(--danger-bg)",
  }[tone] || "var(--accent-navy-bg)";

  const safeDelta = renderDelta(delta);

  return (
    <div style={{
      background: "var(--bg-card)",
      border: "1px solid var(--if-line)",
      borderRadius: 10,
      padding: 16,
      display: "flex",
      flexDirection: "column",
      gap: 6,
      minHeight: 96,
      position: "relative",
    }}>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 8,
      }}>
        <div style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--text-tertiary)",
          textTransform: "uppercase",
          letterSpacing: 0.4,
          lineHeight: 1.3,
        }}>
          {label}
        </div>
        {Icon && (
          <div style={{
            flexShrink: 0,
            width: 28,
            height: 28,
            borderRadius: 6,
            background: accentBg,
            color: toneColor,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}>
            <Icon size={16} />
          </div>
        )}
      </div>

      {loading ? (
        <div style={{
          height: 28,
          width: "60%",
          background: "var(--bg-panel)",
          borderRadius: 4,
          marginTop: 2,
        }} />
      ) : (
        <div style={{
          fontSize: 26,
          fontWeight: 700,
          color: toneColor,
          lineHeight: 1.1,
        }}>
          {value ?? "—"}
        </div>
      )}

      {(sublabel || safeDelta != null) && !loading && (
        <div style={{
          fontSize: 12,
          color: "var(--text-tertiary)",
          lineHeight: 1.4,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}>
          {safeDelta != null && (
            <span style={{
              fontWeight: 600,
              color: toneColor,
              fontSize: 12,
            }}>{safeDelta}</span>
          )}
          {sublabel}
        </div>
      )}
    </div>
  );
}
