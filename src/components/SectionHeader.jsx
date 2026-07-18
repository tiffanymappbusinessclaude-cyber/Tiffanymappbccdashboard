/**
 * SectionHeader — title + subtitle/description + optional icon + optional actions cluster.
 *
 * Props:
 *   title       — string (required)
 *   subtitle    — string (short single-line beneath title)
 *   description — string (longer paragraph; renders below subtitle when present)
 *   icon        — lucide-react icon component
 *   actions     — ReactNode rendered at the right edge (Ask Claude button, primary CTA, etc.)
 *
 * Layout: [icon] [title / subtitle / description] ────────── [actions]
 */
export default function SectionHeader({ title, subtitle, description, icon: Icon, actions }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "flex-start",
      gap: 12,
      marginBottom: 20,
      paddingBottom: 16,
      borderBottom: "1px solid #E2E8F0",
    }}>
      {Icon && (
        <div style={{
          flexShrink: 0,
          width: 40,
          height: 40,
          borderRadius: 8,
          background: "var(--accent-navy-bg)",
          color: "var(--accent-navy)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}>
          <Icon size={22} />
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>
          {title}
        </div>
        {subtitle && (
          <div style={{
            fontSize: 12,
            color: "var(--text-tertiary)",
            marginTop: 4,
            lineHeight: 1.5,
          }}>
            {subtitle}
          </div>
        )}
        {description && (
          <div style={{
            fontSize: 12,
            color: "var(--text-tertiary)",
            marginTop: subtitle ? 2 : 4,
            lineHeight: 1.55,
          }}>
            {description}
          </div>
        )}
      </div>
      {actions && (
        <div style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}>
          {actions}
        </div>
      )}
    </div>
  );
}
