import { useState, useEffect, useRef } from "react";
import { supabase, AGENCY_ID } from "../lib/supabase.js";

// ============================================================
// HelpButton — shared help affordance in the BCC shell header.
// Reads from module_help table keyed by current activeModule slug.
// Content is editable directly in Supabase without a redeploy.
// ============================================================

const T = {
  navy: "var(--accent-navy)", blue: "var(--accent-blue)",
  slate900: "var(--text-primary)", slate800: "var(--text-primary)",
  slate700: "var(--text-secondary)", slate600: "var(--text-secondary)",
  slate500: "var(--text-tertiary)", slate400: "var(--text-quaternary)",
  slate300: "var(--border-strong)", slate200: "var(--border-subtle)",
  slate100: "var(--bg-panel)", slate50: "var(--bg-panel-subtle)",
  white: "var(--bg-card)", blueLt: "var(--accent-blue-bg)",
  amberLt: "var(--warning-bg)", amber: "var(--warning)",
  greenLt: "var(--success-bg)", green: "var(--success)",
  // Literal color for text on dark navy backgrounds (help drawer header)
  textOnHeader: "#F1F5F9",
};

// Very small markdown-ish renderer for our body_md content.
// Handles: headers (## ###), bold, code, unordered/numbered lists, links, paragraphs, hr.
function renderMarkdown(md) {
  if (!md) return null;
  const lines = md.split("\n");
  const blocks = [];
  let i = 0;
  const parseInline = (text) => {
    // bold **x** → <strong>, code `x` → <code>, links [x](y)
    const parts = [];
    let cursor = 0;
    const patterns = [
      { re: /\*\*([^*]+)\*\*/g, wrap: (m) => <strong key={cursor++} style={{ fontWeight: 700, color: T.slate900 }}>{m[1]}</strong> },
      { re: /`([^`]+)`/g, wrap: (m) => <code key={cursor++} style={{ background: T.slate100, padding: "1px 5px", borderRadius: 4, fontSize: 11, fontFamily: "ui-monospace, monospace", color: T.slate800 }}>{m[1]}</code> },
      { re: /\[([^\]]+)\]\(([^)]+)\)/g, wrap: (m) => <a key={cursor++} href={m[2]} target="_blank" rel="noopener noreferrer" style={{ color: T.blue, textDecoration: "underline" }}>{m[1]}</a> },
    ];
    // Simple approach: apply patterns in order, splitting text nodes
    let nodes = [text];
    patterns.forEach(({ re, wrap }) => {
      const next = [];
      nodes.forEach(node => {
        if (typeof node !== "string") { next.push(node); return; }
        let last = 0;
        for (const match of node.matchAll(re)) {
          if (match.index > last) next.push(node.slice(last, match.index));
          next.push(wrap(match));
          last = match.index + match[0].length;
        }
        if (last < node.length) next.push(node.slice(last));
      });
      nodes = next;
    });
    return nodes;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    // Headers
    if (line.startsWith("### ")) { blocks.push(<h4 key={i} style={{ fontSize: 12, fontWeight: 700, color: T.slate800, marginTop: 14, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>{parseInline(line.slice(4))}</h4>); i++; continue; }
    if (line.startsWith("## "))  { blocks.push(<h3 key={i} style={{ fontSize: 13, fontWeight: 800, color: T.navy, marginTop: 16, marginBottom: 8 }}>{parseInline(line.slice(3))}</h3>); i++; continue; }
    if (line.startsWith("# "))   { blocks.push(<h2 key={i} style={{ fontSize: 15, fontWeight: 800, color: T.navy, marginTop: 18, marginBottom: 8 }}>{parseInline(line.slice(2))}</h2>); i++; continue; }
    // HR
    if (line.trim() === "---") { blocks.push(<hr key={i} style={{ border: 0, borderTop: `1px solid ${T.slate200}`, margin: "14px 0" }} />); i++; continue; }
    // Unordered list
    if (/^[-*] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(<li key={i} style={{ marginBottom: 4, lineHeight: 1.5 }}>{parseInline(lines[i].replace(/^[-*] /, ""))}</li>);
        i++;
      }
      blocks.push(<ul key={`ul-${i}`} style={{ paddingLeft: 20, margin: "6px 0", fontSize: 12, color: T.slate700 }}>{items}</ul>);
      continue;
    }
    // Numbered list
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(<li key={i} style={{ marginBottom: 4, lineHeight: 1.5 }}>{parseInline(lines[i].replace(/^\d+\.\s+/, ""))}</li>);
        i++;
      }
      blocks.push(<ol key={`ol-${i}`} style={{ paddingLeft: 20, margin: "6px 0", fontSize: 12, color: T.slate700 }}>{items}</ol>);
      continue;
    }
    // Paragraph (collect until blank line)
    const para = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith("#") && !/^[-*] /.test(lines[i]) && !/^\d+\.\s+/.test(lines[i]) && lines[i].trim() !== "---") {
      para.push(lines[i]);
      i++;
    }
    blocks.push(<p key={`p-${i}`} style={{ fontSize: 12, color: T.slate700, lineHeight: 1.6, margin: "6px 0" }}>{parseInline(para.join(" "))}</p>);
  }
  return blocks;
}

export default function HelpButton({ moduleSlug }) {
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const drawerRef = useRef(null);

  useEffect(() => {
    if (!open || !moduleSlug) return;
    let alive = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const { data, error } = await supabase
          .from("module_help")
          .select("*")
          .eq("agency_id", AGENCY_ID)
          .eq("module_slug", moduleSlug)
          .maybeSingle();
        if (!alive) return;
        // Missing-table errors (42P01) or RLS misses should degrade gracefully,
        // not surface as a red error banner — the fallback amber "no help written"
        // panel is a friendlier signal. We only surface real errors here.
        if (error && !/does not exist|permission denied/i.test(error.message || "")) {
          setError(error.message);
        }
        setHelp(data || null);
      } catch (err) {
        // Network / thrown exceptions (e.g. table missing on some deployments)
        // must never leave the drawer stuck on "Loading…" — degrade to fallback.
        if (!alive) return;
        console.warn("[HelpButton] help fetch failed, degrading to fallback:", err);
        setHelp(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [open, moduleSlug]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Help for this module"
        aria-label="Help"
        style={{
          background: "transparent", border: "1px solid rgba(148, 163, 184, 0.4)", color: T.textOnHeader,
          borderRadius: "50%", width: 30, height: 30,
          fontSize: 14, fontWeight: 700, cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "background 0.15s, border-color 0.15s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(148, 163, 184, 0.15)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >?</button>

      {open && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.4)", zIndex: 90 }}
          />
          {/* Drawer */}
          <div
            ref={drawerRef}
            role="dialog"
            style={{
              position: "fixed", top: 0, right: 0, bottom: 0, width: 480, maxWidth: "94vw",
              background: T.white, zIndex: 100, boxShadow: "-8px 0 24px rgba(15,23,42,0.15)",
              display: "flex", flexDirection: "column",
            }}
          >
            {/* Header */}
            <div style={{ padding: "18px 22px", borderBottom: `1px solid ${T.slate200}`, background: T.navy, color: T.textOnHeader }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: T.slate300, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Help</div>
                  <div style={{ fontSize: 18, fontWeight: 800 }}>{help?.title || (loading ? "Loading…" : moduleSlug)}</div>
                  {help?.what_it_does && (
                    <div style={{ fontSize: 12, color: T.slate300, marginTop: 5, lineHeight: 1.5 }}>{help.what_it_does}</div>
                  )}
                </div>
                <button
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  style={{ background: "transparent", color: T.textOnHeader, border: "none", fontSize: 22, cursor: "pointer", lineHeight: 1, padding: 0, flexShrink: 0 }}
                >×</button>
              </div>
            </div>

            {/* Body */}
            <div style={{ flex: 1, overflow: "auto", padding: "18px 22px" }}>
              {loading && <div style={{ color: T.slate500, fontSize: 12 }}>Loading help…</div>}
              {error && <div style={{ color: "#DC2626", fontSize: 12 }}>Could not load help: {error}</div>}
              {!loading && !error && !help && (
                <div style={{ background: T.amberLt, border: `1px solid ${T.amber}`, borderRadius: 8, padding: "12px 14px", fontSize: 12, color: T.slate700 }}>
                  No help written for this module yet ({moduleSlug}). Add a row to <code style={{ fontFamily: "ui-monospace, monospace", background: T.white, padding: "1px 5px", borderRadius: 4 }}>module_help</code> with <code style={{ fontFamily: "ui-monospace, monospace", background: T.white, padding: "1px 5px", borderRadius: 4 }}>module_slug='{moduleSlug}'</code>.
                </div>
              )}
              {help && (
                <>
                  {help.quick_tips && help.quick_tips.length > 0 && (
                    <div style={{ background: T.blueLt, borderRadius: 8, padding: "12px 14px", marginBottom: 14 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: T.blue, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Quick tips</div>
                      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: T.slate800 }}>
                        {help.quick_tips.map((t, i) => <li key={i} style={{ marginBottom: 3, lineHeight: 1.5 }}>{t}</li>)}
                      </ul>
                    </div>
                  )}
                  <div>{renderMarkdown(help.body_md)}</div>
                  {help.related_slugs && help.related_slugs.length > 0 && (
                    <div style={{ marginTop: 20, paddingTop: 12, borderTop: `1px solid ${T.slate200}` }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: T.slate600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Related in the wiki</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {help.related_slugs.map((s, i) => (
                          <span key={i} style={{ display: "inline-flex", alignItems: "center", padding: "3px 9px", background: T.slate100, borderRadius: 12, fontSize: 11, color: T.slate700, fontFamily: "ui-monospace, monospace" }}>{s}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: "12px 22px", borderTop: `1px solid ${T.slate200}`, background: T.slate50, fontSize: 11, color: T.slate500, textAlign: "center" }}>
              Press <kbd style={{ background: T.white, border: `1px solid ${T.slate300}`, borderRadius: 4, padding: "0 5px", fontFamily: "ui-monospace, monospace", fontSize: 10 }}>Esc</kbd> to close · Content editable in <code style={{ fontFamily: "ui-monospace, monospace" }}>module_help</code>
            </div>
          </div>
        </>
      )}
    </>
  );
}
