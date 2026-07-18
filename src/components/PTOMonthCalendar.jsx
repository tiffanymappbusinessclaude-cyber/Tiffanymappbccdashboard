// =============================================================================
// PTOMonthCalendar — shared month-grid calendar for PTOMine + PTOAdmin
// -----------------------------------------------------------------------------
// Renders a full-month grid (Sun–Sat) with per-day PTO chips overlaid.
// Prev/next month navigation. Coverage conflicts (2+ people off) highlighted.
//
// Props:
//   requests      : array of PTO request rows shaped like v_pto_my_requests
//                   (needs start_date, end_date, staff_name, status,
//                    is_half_day, half_day_period, staff_id). Approved +
//                   pending both accepted; declined/cancelled filtered out.
//   currentUserId : optional; when a chip belongs to this staff_id it is
//                   marked "You" and gets primary color styling.
//   showCoverageFlags : when true, days with 2+ approved requests get a
//                       warning outline (default true for admin view,
//                       false for mine).
//   compact       : denser layout for embedded contexts (default false).
//   className     : optional extra class for the outer wrapper.
// =============================================================================

import { useMemo, useState } from "react";

const monthLabel = (d) =>
  d.toLocaleDateString(undefined, { month: "long", year: "numeric" });

const DAY_HEADERS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseISODate(iso) {
  if (!iso) return null;
  // Interpret as LOCAL date, not UTC — avoids off-by-one on Pacific timezone
  const [y, m, dd] = iso.split("T")[0].split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !dd) return null;
  return new Date(y, m - 1, dd);
}

/** Build a 6-row (42-cell) grid starting on the Sunday before the 1st */
function buildMonthGrid(view) {
  const first = new Date(view.getFullYear(), view.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay()); // roll back to Sunday
  const cells = [];
  const cursor = new Date(start);
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return cells;
}

/** Expand each PTO request into { date -> [request, ...] } bucket map */
function bucketByDay(requests) {
  const map = new Map();
  for (const r of requests || []) {
    if (!r || !r.start_date || !r.end_date) continue;
    if (r.status !== "approved" && r.status !== "pending") continue;
    const start = parseISODate(r.start_date);
    const end   = parseISODate(r.end_date);
    if (!start || !end) continue;
    const cursor = new Date(start);
    while (cursor <= end) {
      const key = toISODate(cursor);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return map;
}

export default function PTOMonthCalendar({
  requests,
  currentUserId,
  showCoverageFlags = true,
  compact = false,
  className,
}) {
  const [view, setView] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const dayMap = useMemo(() => bucketByDay(requests), [requests]);
  const cells  = useMemo(() => buildMonthGrid(view), [view]);
  const todayISO = toISODate(new Date());

  const goPrev  = () => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1));
  const goNext  = () => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1));
  const goToday = () => {
    const now = new Date();
    setView(new Date(now.getFullYear(), now.getMonth(), 1));
  };

  const currentMonth = view.getMonth();

  return (
    <div className={className} style={{ background: "var(--if-white, #ffffff)", border: "1px solid var(--if-line, #E8E0D5)", borderRadius: 12, overflow: "hidden" }}>
      {/* Header: month label + prev/next */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: compact ? "10px 12px" : "12px 16px",
        borderBottom: "1px solid var(--if-line, #E8E0D5)",
        background: "var(--if-cream, #F5F0EB)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            onClick={goPrev}
            title="Previous month"
            style={btnStyle}
          >‹</button>
          <button
            type="button"
            onClick={goNext}
            title="Next month"
            style={btnStyle}
          >›</button>
          <div style={{ fontSize: compact ? 13 : 14, fontWeight: 700, color: "var(--if-navy, #1A2744)", marginLeft: 4 }}>
            {monthLabel(view)}
          </div>
        </div>
        <button
          type="button"
          onClick={goToday}
          style={{ ...btnStyle, padding: "4px 10px", width: "auto", fontSize: 11, fontWeight: 600 }}
        >
          Today
        </button>
      </div>

      {/* Day-of-week headers */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
        borderBottom: "1px solid var(--if-line, #E8E0D5)",
        background: "var(--if-cream-deep, #EDE4D3)",
      }}>
        {DAY_HEADERS.map((h) => (
          <div key={h} style={{
            padding: "6px 8px",
            fontSize: 10, fontWeight: 600, letterSpacing: "0.08em",
            color: "var(--text-tertiary)", textTransform: "uppercase",
            textAlign: "center",
          }}>{h}</div>
        ))}
      </div>

      {/* Grid */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
        gap: 0,
      }}>
        {cells.map((cellDate, i) => {
          const iso = toISODate(cellDate);
          const inMonth = cellDate.getMonth() === currentMonth;
          const isToday = iso === todayISO;
          const dayRequests = dayMap.get(iso) || [];
          const approvedCount = dayRequests.filter((r) => r.status === "approved").length;
          const conflict = showCoverageFlags && approvedCount >= 2;

          return (
            <div
              key={i}
              style={{
                position: "relative",
                minHeight: compact ? 70 : 96,
                padding: 6,
                borderRight: (i % 7 !== 6) ? "1px solid var(--if-line, #E8E0D5)" : "none",
                borderBottom: (i < 35) ? "1px solid var(--if-line, #E8E0D5)" : "none",
                background: inMonth
                  ? (conflict ? "var(--warning-bg)" : "var(--bg-card)")
                  : "#FAFAFA",
                opacity: inMonth ? 1 : 0.55,
                outline: isToday ? "2px solid #2D7DD2" : "none",
                outlineOffset: -2,
              }}
              title={conflict ? `${approvedCount} people off — coverage conflict` : undefined}
            >
              <div style={{
                fontSize: 11,
                fontWeight: isToday ? 700 : 500,
                color: isToday ? "var(--accent-blue)" : (inMonth ? "#1A2744" : "var(--text-quaternary)"),
                marginBottom: 4,
              }}>
                {cellDate.getDate()}
              </div>

              {/* Chip stack — max 3 shown, rest as "+N more" */}
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {dayRequests.slice(0, 3).map((r, idx) => (
                  <PTOChip key={r.id + "|" + idx} req={r} currentUserId={currentUserId} />
                ))}
                {dayRequests.length > 3 && (
                  <div style={{ fontSize: 9, color: "var(--text-tertiary)", padding: "1px 4px" }}>
                    +{dayRequests.length - 3} more
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{
        padding: "8px 12px",
        borderTop: "1px solid var(--if-line, #E8E0D5)",
        background: "var(--if-cream, #F5F0EB)",
        display: "flex",
        gap: 14,
        flexWrap: "wrap",
        fontSize: 10,
        color: "var(--text-tertiary)",
      }}>
        <LegendSwatch color="#0E7C7B" label="Approved" />
        <LegendSwatch color="var(--warning)" label="Pending" style={{ borderStyle: "dashed" }} />
        {showCoverageFlags && <LegendSwatch color="var(--warning-bg)" borderColor="var(--warning)" label="Coverage conflict" />}
      </div>
    </div>
  );
}

// ─── Small building blocks ────────────────────────────────────
const btnStyle = {
  width: 26, height: 26,
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  borderRadius: 6,
  border: "1px solid var(--if-line, #E8E0D5)",
  background: "var(--bg-card)",
  color: "#1A2744",
  fontSize: 14, lineHeight: 1,
  cursor: "pointer",
};

function PTOChip({ req, currentUserId }) {
  const isMine = currentUserId && req.staff_id === currentUserId;
  const approved = req.status === "approved";
  const bg = approved
    ? (isMine ? "#0E7C7B" : "#0E7C7B22")
    : (isMine ? "var(--warning)" : "#F59E0B22");
  const color = approved
    ? (isMine ? "var(--bg-card)" : "#0E7C7B")
    : (isMine ? "var(--bg-card)" : "#92400E");
  const borderStyle = approved ? "solid" : "dashed";

  const label = req.is_half_day
    ? `${req.staff_name || "—"} · ½${req.half_day_period ? " " + req.half_day_period : ""}`
    : (req.staff_name || "—");

  return (
    <div
      title={`${req.staff_name} — ${req.status}${req.reason ? " · " + req.reason : ""}`}
      style={{
        fontSize: 10,
        fontWeight: 600,
        color,
        background: bg,
        border: `1px ${borderStyle} ${approved ? "#0E7C7B" : "var(--warning)"}`,
        borderRadius: 4,
        padding: "1px 5px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {label}
    </div>
  );
}

function LegendSwatch({ color, borderColor, label, style }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{
        display: "inline-block",
        width: 12, height: 10,
        background: color,
        border: `1px solid ${borderColor || color}`,
        borderRadius: 3,
        ...style,
      }} />
      {label}
    </div>
  );
}
