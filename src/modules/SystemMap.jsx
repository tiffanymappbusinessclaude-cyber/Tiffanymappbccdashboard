import { useState, useMemo, useRef, useEffect } from "react";
import { useSupabaseQuery } from "../lib/hooks.js";
import { supabase } from "../lib/supabase.js";
import { fmtDate } from "../lib/utils.js";
import LoadingState from "../components/LoadingState.jsx";
import EmptyState from "../components/EmptyState.jsx";

// ============================================================
// BCC WIKI & SYSTEM MAP MODULE v1.0
// Business Command Center — State Farm Agent Edition
// Built by Imaginary Farms LLC · imaginary-farms.com
// DATA: Reads/writes public.system_map (migration 045).
// ============================================================

const T = {navy:"#1B2B4B",blue:"#2D7DD2",blueLt:"#EFF6FF",green:"#10B981",greenLt:"#D1FAE5",amber:"#F59E0B",amberLt:"#FEF3C7",red:"#EF4444",redLt:"#FEE2E2",purple:"#7C3AED",purpleLt:"#EDE9FE",teal:"#0D9488",tealLt:"#CCFBF1",slate50:"#F8FAFC",slate100:"#F1F5F9",slate200:"#E2E8F0",slate300:"#CBD5E1",slate400:"#94A3B8",slate500:"#64748B",slate600:"#475569",slate700:"#334155",slate800:"#1E293B",slate900:"#0F172A",white:"#FFFFFF"};

const CATEGORIES = [
  { key: "all",         label: "All",         icon: "📚", color: T.slate600 },
  { key: "overview",    label: "Overview",    icon: "🗺️", color: T.blue },
  { key: "domain",      label: "Domain",      icon: "🏢", color: T.navy },
  { key: "schema",      label: "Schema",      icon: "🗃️", color: T.purple },
  { key: "integration", label: "Integration", icon: "🔌", color: T.teal },
  { key: "automation",  label: "Automation",  icon: "⚡", color: T.amber },
  { key: "decision",    label: "Decision",    icon: "🧭", color: T.green },
  { key: "runbook",     label: "Runbook",     icon: "📖", color: T.red },
  { key: "glossary",    label: "Glossary",    icon: "🔤", color: T.slate700 },
];
const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));
const STALE_DAYS = 30;

function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function AskBtn({ context, size = "normal" }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef(null);
  const small = size === "small";
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setTimeout(() => setCopied(false), 200); } };
    const k = (e) => { if (e.key === "Escape") { setOpen(false); setTimeout(() => setCopied(false), 200); } };
    document.addEventListener("mousedown", h); document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [open]);
  const ask = async () => {
    setOpen(true);
    try { await navigator.clipboard.writeText(context); setCopied(true); } catch { setCopied(true); }
  };
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button onClick={open ? () => setOpen(false) : ask} style={{ display: "flex", alignItems: "center", gap: 5, background: open ? T.slate100 : T.blue, color: open ? T.blue : T.white, border: open ? `1px solid ${T.blue}` : "1px solid transparent", borderRadius: 7, padding: small ? "5px 10px" : "7px 13px", fontSize: small ? 10 : 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>⚡ Ask Claude</button>
      {open && (
        <div role="dialog" style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, zIndex: 60, width: 300, background: T.white, border: `1px solid ${T.slate100}`, borderRadius: 12, boxShadow: "0 12px 32px rgba(15,23,42,0.16)", padding: 14, textAlign: "left" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#16A34A", marginBottom: 4 }}>{copied ? "✓ Context copied to your clipboard" : "Copying…"}</div>
          <div style={{ fontSize: 11, color: T.slate500, marginBottom: 10, lineHeight: 1.5 }}>Paste it into your Claude.ai tab. Your BCC data goes with the prompt.</div>
          <button onClick={() => window.open("https://claude.ai/new", "_blank", "noopener,noreferrer")} style={{ width: "100%", background: T.navy, color: T.white, border: "none", borderRadius: 7, padding: "8px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Open Claude.ai in a new tab</button>
        </div>
      )}
    </div>
  );
}

function DeleteBtn({ onConfirm, label = "Delete" }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return <button onClick={armed ? onConfirm : () => setArmed(true)} style={{ background: armed ? T.red : T.white, color: armed ? T.white : T.red, border: `1px solid ${T.red}`, borderRadius: 7, padding: "7px 13px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>{armed ? "Click again to confirm" : label}</button>;
}

function CategoryBadge({ category }) {
  const c = CATEGORY_MAP[category] || CATEGORY_MAP.all;
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: c.color, background: T.slate50, border: `1px solid ${T.slate200}`, padding: "3px 8px", borderRadius: 20 }}><span>{c.icon}</span><span>{c.label}</span></span>;
}

function StaleIndicator({ verifiedAt }) {
  const d = daysSince(verifiedAt);
  if (d === null) return <span style={{ fontSize: 10, color: T.slate400, fontStyle: "italic" }}>Never verified</span>;
  const stale = d >= STALE_DAYS;
  return <span style={{ fontSize: 10, color: stale ? T.red : T.slate500, display: "inline-flex", alignItems: "center", gap: 4 }}>{stale ? "⚠" : "🕒"} Verified {d === 0 ? "today" : `${d}d ago`}</span>;
}

function FilterPill({ active, onClick, children }) {
  return <button onClick={onClick} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: active ? T.navy : T.white, color: active ? T.white : T.slate600, border: `1px solid ${active ? T.navy : T.slate200}`, borderRadius: 20, padding: "6px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>{children}</button>;
}

function renderInline(text) {
  const parts = [];
  let rest = text || "";
  let idx = 0;
  const patterns = [
    { re: /`([^`]+)`/,               render: (m, k) => <code key={k} style={{ background: T.slate100, padding: "2px 5px", borderRadius: 4, fontSize: "0.85em", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{m[1]}</code> },
    { re: /\*\*([^*]+)\*\*/,         render: (m, k) => <strong key={k}>{m[1]}</strong> },
    { re: /\*([^*]+)\*/,             render: (m, k) => <em key={k}>{m[1]}</em> },
    { re: /\[([^\]]+)\]\(([^)]+)\)/, render: (m, k) => <a key={k} href={m[2]} target="_blank" rel="noreferrer" style={{ color: T.blue, textDecoration: "underline" }}>{m[1]}</a> },
  ];
  while (rest.length > 0) {
    let earliest = null, earliestIdx = Infinity, earliestPattern = null;
    for (const p of patterns) {
      const m = p.re.exec(rest);
      if (m && m.index < earliestIdx) { earliest = m; earliestIdx = m.index; earliestPattern = p; }
    }
    if (!earliest) { parts.push(rest); break; }
    if (earliestIdx > 0) parts.push(rest.slice(0, earliestIdx));
    parts.push(earliestPattern.render(earliest, `inline-${idx++}`));
    rest = rest.slice(earliestIdx + earliest[0].length);
  }
  return parts;
}

function renderMarkdown(md) {
  if (!md) return null;
  const src = md.split("\n");
  const out = [];
  let i = 0, k = 0;
  while (i < src.length) {
    const line = src[i];
    if (line.startsWith("```")) {
      const buf = [];
      i++;
      while (i < src.length && !src[i].startsWith("```")) { buf.push(src[i]); i++; }
      i++;
      out.push(<pre key={`c-${k++}`} style={{ background: T.slate900, color: T.slate100, padding: 14, borderRadius: 8, fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", overflowX: "auto", lineHeight: 1.55, margin: "10px 0" }}>{buf.join("\n")}</pre>);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      const level = h[1].length;
      const sizes = { 1: 22, 2: 18, 3: 15, 4: 13 };
      const weights = { 1: 800, 2: 700, 3: 700, 4: 600 };
      const margins = { 1: "20px 0 10px", 2: "18px 0 8px", 3: "14px 0 6px", 4: "12px 0 4px" };
      out.push(<div key={`h-${k++}`} style={{ fontSize: sizes[level], fontWeight: weights[level], color: T.slate900, margin: margins[level], letterSpacing: "-0.01em" }}>{renderInline(h[2])}</div>);
      i++;
      continue;
    }
    if (line.startsWith("> ")) {
      const buf = [];
      while (i < src.length && src[i].startsWith("> ")) { buf.push(src[i].slice(2)); i++; }
      out.push(<div key={`q-${k++}`} style={{ borderLeft: `3px solid ${T.blue}`, padding: "6px 12px", margin: "10px 0", background: T.blueLt, color: T.slate700, fontSize: 13, lineHeight: 1.6 }}>{renderInline(buf.join(" "))}</div>);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < src.length && /^[-*]\s+/.test(src[i])) { items.push(src[i].replace(/^[-*]\s+/, "")); i++; }
      out.push(<ul key={`u-${k++}`} style={{ margin: "8px 0 8px 20px", padding: 0, fontSize: 13, color: T.slate700, lineHeight: 1.6 }}>{items.map((it, ii) => <li key={ii} style={{ marginBottom: 4 }}>{renderInline(it)}</li>)}</ul>);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < src.length && /^\d+\.\s+/.test(src[i])) { items.push(src[i].replace(/^\d+\.\s+/, "")); i++; }
      out.push(<ol key={`o-${k++}`} style={{ margin: "8px 0 8px 20px", padding: 0, fontSize: 13, color: T.slate700, lineHeight: 1.6 }}>{items.map((it, ii) => <li key={ii} style={{ marginBottom: 4 }}>{renderInline(it)}</li>)}</ol>);
      continue;
    }
    if (line.includes("|") && i + 1 < src.length && /^[\s|:-]+$/.test(src[i + 1])) {
      const parseRow = (r) => r.split("|").map((c) => c.trim()).filter((c, ii, arr) => !(ii === 0 && c === "") && !(ii === arr.length - 1 && c === ""));
      const header = parseRow(line);
      i += 2;
      const rows = [];
      while (i < src.length && src[i].includes("|") && src[i].trim() !== "") { rows.push(parseRow(src[i])); i++; }
      out.push(<div key={`t-${k++}`} style={{ overflowX: "auto", margin: "10px 0", border: `1px solid ${T.slate200}`, borderRadius: 8 }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}><thead><tr style={{ background: T.slate50 }}>{header.map((h, ii) => <th key={ii} style={{ textAlign: "left", padding: "8px 10px", fontWeight: 700, color: T.slate700, borderBottom: `1px solid ${T.slate200}` }}>{renderInline(h)}</th>)}</tr></thead><tbody>{rows.map((r, ri) => <tr key={ri} style={{ borderBottom: `1px solid ${T.slate100}` }}>{r.map((c, ci) => <td key={ci} style={{ padding: "8px 10px", color: T.slate700, verticalAlign: "top" }}>{renderInline(c)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    const buf = [line];
    i++;
    while (i < src.length && src[i].trim() !== "" && !src[i].startsWith("#") && !src[i].startsWith("```") && !src[i].startsWith("> ") && !/^[-*]\s+/.test(src[i]) && !/^\d+\.\s+/.test(src[i]) && !src[i].includes("|")) { buf.push(src[i]); i++; }
    out.push(<p key={`p-${k++}`} style={{ margin: "8px 0", fontSize: 13, color: T.slate700, lineHeight: 1.65 }}>{renderInline(buf.join(" "))}</p>);
  }
  return <div>{out}</div>;
}

function PageCard({ page, onOpen }) {
  return (
    <button onClick={() => onOpen(page.slug)} style={{ display: "block", width: "100%", textAlign: "left", background: T.white, border: `1px solid ${T.slate200}`, borderRadius: 10, padding: 14, cursor: "pointer", transition: "border-color 0.15s, box-shadow 0.15s" }} onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.blue; e.currentTarget.style.boxShadow = "0 4px 12px rgba(45,125,210,0.08)"; }} onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.slate200; e.currentTarget.style.boxShadow = "none"; }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
        <CategoryBadge category={page.category} />
        <StaleIndicator verifiedAt={page.last_verified_at} />
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: T.slate900, marginBottom: 4, lineHeight: 1.3 }}>{page.title}</div>
      {page.summary && <div style={{ fontSize: 12, color: T.slate500, lineHeight: 1.5 }}>{page.summary.length > 140 ? page.summary.slice(0, 140).trim() + "…" : page.summary}</div>}
    </button>
  );
}

function PageDetail({ page, onBack, onEdit, onRefresh, allPagesBySlug }) {
  const [bumping, setBumping] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const bumpVerified = async () => {
    if (!supabase) return;
    setBumping(true);
    try {
      const { error } = await supabase.rpc("bump_system_map_verified", { p_slug: page.slug, p_by: "owner" });
      if (error) throw error;
      await onRefresh();
    } catch (err) { alert("Could not update verified date: " + (err.message || err)); }
    finally { setBumping(false); }
  };
  const askContext = `Wiki page: ${page.title}\nSlug: ${page.slug}\nCategory: ${page.category}\n\n---\n\n${page.body_md || ""}`;
  const related = (page.related_slugs || []).map((s) => allPagesBySlug[s]).filter(Boolean);
  return (
    <div style={{ background: T.white, borderRadius: 12, border: `1px solid ${T.slate200}`, overflow: "hidden" }}>
      <div style={{ padding: "16px 20px", borderBottom: `1px solid ${T.slate200}`, background: T.slate50, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <button onClick={onBack} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "transparent", color: T.slate600, border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>← Back to wiki</button>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={bumpVerified} disabled={bumping} style={{ background: T.white, color: T.green, border: `1px solid ${T.green}`, borderRadius: 7, padding: "7px 12px", fontSize: 11, fontWeight: 600, cursor: bumping ? "wait" : "pointer" }}>{bumping ? "Updating…" : "✓ Mark verified"}</button>
          <button onClick={() => setShowHistory(true)} style={{ background: T.white, color: T.slate600, border: `1px solid ${T.slate300}`, borderRadius: 7, padding: "7px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>🕒 History</button>
          <AskBtn context={askContext} size="small" />
          <button onClick={onEdit} style={{ background: T.navy, color: T.white, border: "none", borderRadius: 7, padding: "7px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>✎ Edit</button>
        </div>
      </div>
      <div style={{ padding: "22px 26px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <CategoryBadge category={page.category} />
          <StaleIndicator verifiedAt={page.last_verified_at} />
          {page.source_of_truth && <span style={{ fontSize: 10, color: T.slate500, background: T.slate50, border: `1px solid ${T.slate200}`, padding: "3px 8px", borderRadius: 6 }}>Source of truth: {page.source_of_truth}</span>}
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: T.slate900, margin: "6px 0 4px", letterSpacing: "-0.02em" }}>{page.title}</h1>
        {page.summary && <div style={{ fontSize: 14, color: T.slate600, lineHeight: 1.6, marginBottom: 18, fontStyle: "italic" }}>{page.summary}</div>}
        <div>{renderMarkdown(page.body_md)}</div>
        {related.length > 0 && (
          <div style={{ marginTop: 24, paddingTop: 18, borderTop: `1px solid ${T.slate200}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: T.slate500, marginBottom: 10 }}>Related pages</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{related.map((r) => <button key={r.slug} onClick={() => onBack(r.slug)} style={{ background: T.blueLt, color: T.navy, border: `1px solid ${T.blue}`, borderRadius: 20, padding: "5px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>{r.title}</button>)}</div>
          </div>
        )}
      </div>
      {showHistory && <RevisionHistoryModal slug={page.slug} onClose={() => setShowHistory(false)} />}
    </div>
  );
}

function RevisionHistoryModal({ slug, onClose }) {
  const [revisions, setRevisions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supabase) { setErr("Database unavailable"); setLoading(false); return; }
      try {
        const { data, error } = await supabase.from("system_map_revisions").select("*").eq("slug", slug).order("revised_at", { ascending: false }).limit(30);
        if (cancelled) return;
        if (error) throw error;
        setRevisions(data || []);
      } catch (e) { if (!cancelled) setErr(e.message || String(e)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [slug]);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 20 }}>
      <div style={{ background: T.white, borderRadius: 12, maxWidth: 720, width: "100%", maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: "0 25px 50px rgba(0,0,0,0.25)" }}>
        <div style={{ padding: "14px 20px", borderBottom: `1px solid ${T.slate200}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.slate900 }}>Revision history — {slug}</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", fontSize: 20, color: T.slate500, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: "14px 20px", overflowY: "auto" }}>
          {loading && <LoadingState rows={3} message="Loading revisions…" />}
          {err && <div style={{ color: T.red, fontSize: 12, padding: 12, background: T.redLt, borderRadius: 8 }}>{err}</div>}
          {!loading && !err && revisions && revisions.length === 0 && <div style={{ padding: 20, textAlign: "center", color: T.slate500, fontSize: 12 }}>No revisions recorded yet.</div>}
          {!loading && revisions && revisions.map((r, ii) => (
            <div key={ii} style={{ padding: "10px 0", borderBottom: `1px solid ${T.slate100}`, fontSize: 12, color: T.slate600 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <div style={{ fontWeight: 600, color: T.slate800 }}>{r.title || "(untitled)"}</div>
                <div style={{ fontSize: 11 }}>{fmtDate(r.revised_at)}</div>
              </div>
              <div style={{ fontSize: 11, color: T.slate500 }}>Category: {r.category} · Revised by: {r.revised_by || "unknown"}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PageEditor({ initial, onCancel, onSaved, onDeleted }) {
  const isNew = !initial?.slug;
  const [form, setForm] = useState({
    slug: initial?.slug || "",
    title: initial?.title || "",
    category: initial?.category || "overview",
    summary: initial?.summary || "",
    body_md: initial?.body_md || "",
    source_of_truth: initial?.source_of_truth || "",
    sort_order: initial?.sort_order ?? 50,
    related_slugs: (initial?.related_slugs || []).join(", "),
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    if (!supabase) { setErr("Database unavailable"); return; }
    if (!form.slug || !form.title) { setErr("Slug and title are required"); return; }
    setSaving(true); setErr(null);
    try {
      const payload = {
        slug: form.slug.trim(), title: form.title.trim(), category: form.category,
        summary: form.summary || null, body_md: form.body_md || null,
        source_of_truth: form.source_of_truth || null,
        sort_order: Number.isFinite(+form.sort_order) ? +form.sort_order : 50,
        related_slugs: form.related_slugs.split(",").map((s) => s.trim()).filter(Boolean),
        last_verified_at: new Date().toISOString(),
        last_verified_by: "owner",
        updated_at: new Date().toISOString(),
      };
      let result;
      if (isNew) result = await supabase.from("system_map").insert(payload).select().single();
      else result = await supabase.from("system_map").update(payload).eq("slug", initial.slug).select().single();
      if (result.error) throw result.error;
      await onSaved(result.data);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setSaving(false); }
  };
  const del = async () => {
    if (!supabase || !initial?.slug) return;
    try {
      const { error } = await supabase.from("system_map").delete().eq("slug", initial.slug);
      if (error) throw error;
      await onDeleted();
    } catch (e) { setErr(e.message || String(e)); }
  };
  const field = { display: "block", width: "100%", padding: "8px 10px", fontSize: 12, border: `1px solid ${T.slate200}`, borderRadius: 7, background: T.white, color: T.slate900, boxSizing: "border-box", fontFamily: "inherit" };
  const label = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: T.slate600, marginBottom: 6, display: "block" };
  return (
    <div style={{ background: T.white, borderRadius: 12, border: `1px solid ${T.slate200}`, overflow: "hidden" }}>
      <div style={{ padding: "16px 20px", borderBottom: `1px solid ${T.slate200}`, background: T.slate50, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: T.slate900 }}>{isNew ? "New wiki page" : `Edit — ${initial.title}`}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={onCancel} style={{ background: T.white, color: T.slate600, border: `1px solid ${T.slate300}`, borderRadius: 7, padding: "7px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          {!isNew && <DeleteBtn onConfirm={del} />}
          <button onClick={save} disabled={saving} style={{ background: T.blue, color: T.white, border: "none", borderRadius: 7, padding: "7px 14px", fontSize: 11, fontWeight: 700, cursor: saving ? "wait" : "pointer" }}>{saving ? "Saving…" : "💾 Save"}</button>
        </div>
      </div>
      <div style={{ padding: "18px 22px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div><div style={label}>Slug (URL-safe id)</div><input value={form.slug} onChange={(e) => update("slug", e.target.value)} disabled={!isNew} style={{ ...field, background: isNew ? T.white : T.slate50, color: isNew ? T.slate900 : T.slate500 }} placeholder="e.g. runbook-monthly-close" /></div>
        <div><div style={label}>Category</div><select value={form.category} onChange={(e) => update("category", e.target.value)} style={field}>{CATEGORIES.filter((c) => c.key !== "all").map((c) => <option key={c.key} value={c.key}>{c.icon} {c.label}</option>)}</select></div>
        <div style={{ gridColumn: "1 / -1" }}><div style={label}>Title</div><input value={form.title} onChange={(e) => update("title", e.target.value)} style={field} placeholder="Human-readable page title" /></div>
        <div style={{ gridColumn: "1 / -1" }}><div style={label}>Summary (short paragraph)</div><textarea value={form.summary} onChange={(e) => update("summary", e.target.value)} rows={2} style={{ ...field, resize: "vertical", minHeight: 44 }} placeholder="One or two sentences that describe the page" /></div>
        <div style={{ gridColumn: "1 / -1" }}><div style={label}>Body (markdown)</div><textarea value={form.body_md} onChange={(e) => update("body_md", e.target.value)} rows={16} style={{ ...field, resize: "vertical", minHeight: 240, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }} placeholder="# Heading" /></div>
        <div><div style={label}>Source of truth</div><input value={form.source_of_truth} onChange={(e) => update("source_of_truth", e.target.value)} style={field} placeholder="e.g. AA05 § I.B, agency.settings" /></div>
        <div><div style={label}>Sort order</div><input type="number" value={form.sort_order} onChange={(e) => update("sort_order", e.target.value)} style={field} /></div>
        <div style={{ gridColumn: "1 / -1" }}><div style={label}>Related slugs (comma-separated)</div><input value={form.related_slugs} onChange={(e) => update("related_slugs", e.target.value)} style={field} placeholder="bcc-overview, integration-composio" /></div>
        {err && <div style={{ gridColumn: "1 / -1", background: T.redLt, color: T.red, border: `1px solid ${T.red}`, padding: 10, borderRadius: 7, fontSize: 12 }}>{err}</div>}
      </div>
    </div>
  );
}

export default function SystemMap() {
  const { data, loading, error } = useSupabaseQuery(() => supabase.from("system_map").select("*").order("sort_order", { ascending: true }), []);
  const pages = data || [];
  const [selectedSlug, setSelectedSlug] = useState(null);
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("browse");
  const [editing, setEditing] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const forceReload = () => setReloadKey((k) => k + 1);
  const refetch = useSupabaseQuery(() => supabase.from("system_map").select("*").order("sort_order", { ascending: true }), [reloadKey]);
  const livePages = reloadKey === 0 ? pages : (refetch.data || pages);
  const pagesBySlug = useMemo(() => Object.fromEntries(livePages.map((p) => [p.slug, p])), [livePages]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return livePages.filter((p) => {
      if (category !== "all" && p.category !== category) return false;
      if (!q) return true;
      const hay = [p.title, p.summary, p.body_md, p.slug].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [livePages, category, query]);
  const grouped = useMemo(() => {
    const groups = {};
    for (const p of filtered) { const k = p.category || "overview"; if (!groups[k]) groups[k] = []; groups[k].push(p); }
    return groups;
  }, [filtered]);
  const selected = selectedSlug ? pagesBySlug[selectedSlug] : null;
  if (mode === "edit" || mode === "new") return (<div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}><PageEditor initial={mode === "edit" ? editing : null} onCancel={() => { setMode("browse"); setEditing(null); }} onSaved={(row) => { setMode("browse"); setEditing(null); setSelectedSlug(row.slug); forceReload(); }} onDeleted={() => { setMode("browse"); setEditing(null); setSelectedSlug(null); forceReload(); }} /></div>);
  if (selected) return (<div style={{ padding: 24, maxWidth: 1000, margin: "0 auto" }}><PageDetail page={selected} onBack={(nextSlug) => { setSelectedSlug(typeof nextSlug === "string" ? nextSlug : null); }} onEdit={() => { setEditing(selected); setMode("edit"); }} onRefresh={async () => { forceReload(); }} allPagesBySlug={pagesBySlug} /></div>);
  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16, marginBottom: 20 }}>
        <div><div style={{ fontSize: 26, fontWeight: 800, color: T.slate900, letterSpacing: "-0.02em", display: "flex", alignItems: "center", gap: 10 }}>🗺️ Wiki & System Map</div><div style={{ fontSize: 13, color: T.slate500, marginTop: 4 }}>Everything this BCC is and how it works. Editable — every change is revision-tracked.</div></div>
        <button onClick={() => { setEditing(null); setMode("new"); }} style={{ background: T.blue, color: T.white, border: "none", borderRadius: 8, padding: "9px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>+ New page</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 16, alignItems: "center" }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="🔍 Search titles, summaries, body…" style={{ flex: "1 1 260px", maxWidth: 400, padding: "9px 12px", fontSize: 12, border: `1px solid ${T.slate200}`, borderRadius: 8, background: T.white, color: T.slate900, boxSizing: "border-box" }} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{CATEGORIES.map((c) => <FilterPill key={c.key} active={category === c.key} onClick={() => setCategory(c.key)}><span>{c.icon}</span><span>{c.label}</span></FilterPill>)}</div>
      </div>
      {loading && <LoadingState rows={4} message="Loading wiki pages…" />}
      {error && <div style={{ background: T.redLt, color: T.red, border: `1px solid ${T.red}`, padding: 12, borderRadius: 8, fontSize: 12 }}>Failed to load wiki: {error}</div>}
      {!loading && !error && livePages.length === 0 && <EmptyState icon="🗺️" title="No wiki pages yet" description='Seed pages should have been loaded from migration 045 + seed 02. Click "New page" to add one, or contact your Claude to reseed.' />}
      {!loading && !error && livePages.length > 0 && filtered.length === 0 && <div style={{ background: T.white, border: `1px solid ${T.slate200}`, padding: 30, borderRadius: 10, textAlign: "center", color: T.slate500, fontSize: 13 }}>No pages match your search or filter.</div>}
      {!loading && !error && filtered.length > 0 && (
        <div>{CATEGORIES.filter((c) => c.key !== "all" && grouped[c.key]?.length).map((c) => (
          <div key={c.key} style={{ marginBottom: 26 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}><span style={{ fontSize: 13 }}>{c.icon}</span><span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: T.slate600 }}>{c.label}</span><span style={{ fontSize: 11, color: T.slate400 }}>({grouped[c.key].length})</span></div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>{grouped[c.key].map((p) => <PageCard key={p.slug} page={p} onOpen={(slug) => setSelectedSlug(slug)} />)}</div>
          </div>
        ))}</div>
      )}
    </div>
  );
}
