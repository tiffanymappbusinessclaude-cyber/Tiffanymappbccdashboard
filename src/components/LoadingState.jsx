/**
 * LoadingState — skeleton loader while Supabase query runs
 * Shows instead of blank screen or fake data during fetch
 * Accepts either `message` (BCC convention) or `label` (fork-sync convention).
 */
export default function LoadingState({ rows = 4, message, label }) {
  const text = message || label || "Loading your data...";
  return (
    <div style={{ padding: "16px 0" }}>
      <div style={{
        fontSize: 11, color: "var(--text-quaternary)", marginBottom: 16,
        display: "flex", alignItems: "center", gap: 8
      }}>
        <span style={{
          display: "inline-block", width: 8, height: 8,
          borderRadius: "50%", background: "var(--accent-blue)",
          animation: "pulse 1.5s infinite"
        }} />
        {text}
      </div>
      {Array(rows).fill(0).map((_, i) => (
        <div key={i} style={{
          display: "flex", gap: 12, marginBottom: 12, alignItems: "center"
        }}>
          <div style={{
            height: 12, borderRadius: 6, background: "var(--bg-panel)",
            flex: i % 3 === 0 ? 3 : i % 3 === 1 ? 2 : 1,
            opacity: 1 - (i * 0.15)
          }} />
          <div style={{
            height: 12, borderRadius: 6, background: "var(--bg-panel)",
            width: 60, opacity: 0.6
          }} />
          <div style={{
            height: 12, borderRadius: 6, background: "var(--bg-panel)",
            width: 80, opacity: 0.4
          }} />
        </div>
      ))}
    </div>
  );
}
