import { useState, useEffect, useRef } from "react";
import { useSupabaseTable } from "../lib/hooks.js";
import { supabase, AGENCY_ID } from "../lib/supabase.js";

// ============================================================
// BCC PERSISTENT MEMORY MODULE v1.0
// Business Command Center — State Farm Agent Edition
// Built by Imaginary Farms LLC · imaginary-farms.com
//
// PURPOSE:
// The agency brain. Everything Claude needs to know about
// this business lives here. Editable by owner or Claude.
// Categories mirror persistent_memory table in Supabase.
//
// CATEGORIES:
//   agency_profile      — Entity, licenses, contacts
//   staff               — Team members and roles
//   business_rules      — Rules Claude must always follow
//   financial_context   — Accounting setup, CPA, comp structure
//   goals               — Current targets and priorities
//   relationships       — Key contacts and vendors
//   compliance_notes    — Agent-specific compliance reminders
//
// DATA: Reads/writes persistent_memory table in Supabase
// DATA: Loaded from persistent_memory via useSupabaseTable hook.
// ============================================================

// ─── Design Tokens ────────────────────────────────────────────
const T = {
  navy:    "#1B2B4B",
  blue:    "#2D7DD2",
  blueLt:  "#EFF6FF",
  green:   "#10B981",
  greenLt: "#D1FAE5",
  amber:   "#F59E0B",
  amberLt: "#FEF3C7",
  red:     "#EF4444",
  redLt:   "#FEE2E2",
  purple:  "#7C3AED",
  purpleLt:"#EDE9FE",
  teal:    "#0D9488",
  tealLt:  "#CCFBF1",
  slate50: "#F8FAFC",
  slate100:"#F1F5F9",
  slate200:"#E2E8F0",
  slate300:"#CBD5E1",
  slate400:"#94A3B8",
  slate500:"#64748B",
  slate600:"#475569",
  slate700:"#334155",
  slate800:"#1E293B",
  slate900:"#0F172A",
  white:   "#FFFFFF",
};

// ─── Category Config ──────────────────────────────────────────
const CATEGORIES = [
  { id: "agency_profile",    label: "Agency Profile",    icon: "🏢", color: T.blue,   colorLt: T.blueLt,   description: "Entity details, licensing, contact information" },
  { id: "staff",             label: "Staff & Team",      icon: "👥", color: T.purple, colorLt: T.purpleLt, description: "Team members, roles, employment details" },
  { id: "business_rules",    label: "Business Rules",    icon: "⚙️", color: T.navy,   colorLt: T.slate100, description: "Rules Claude must always follow in every conversation" },
  { id: "financial_context", label: "Financial Context", icon: "💰", color: T.green,  colorLt: T.greenLt,  description: "Accounting setup, CPA details, compensation structure" },
  { id: "goals",             label: "Goals & Priorities",icon: "🎯", color: T.amber,  colorLt: T.amberLt,  description: "Current targets, priorities, milestones" },
  { id: "relationships",     label: "Key Relationships", icon: "🤝", color: T.teal,   colorLt: T.tealLt,   description: "CPA, vendors, SF contacts, key business relationships" },
  { id: "compliance_notes",  label: "Compliance Notes",  icon: "🛡️", color: T.red,    colorLt: T.redLt,    description: "Agency-specific compliance reminders and notes" },
];

// ─── Shared Components ────────────────────────────────────────
const AskBtn = ({ context, size = "normal", demoMode = false }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [opened, setOpened] = useState(false);
  const ref = useRef(null);
  const small = size === "small";
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setTimeout(() => { setCopied(false); setOpened(false); }, 200); } };
    const k = (e) => { if (e.key === "Escape") { setOpen(false); setTimeout(() => { setCopied(false); setOpened(false); }, 200); } };
    document.addEventListener("mousedown", h); document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [open]);
  const ask = async () => {
    setOpen(true); setOpened(false);
    try { await navigator.clipboard.writeText(context); setCopied(true); } catch { setCopied(true); }
  };
  const go = () => { setOpened(true); if (!demoMode) window.open("https://claude.ai/new", "_blank", "noopener,noreferrer"); };
  const preview = context && context.length > 220 ? context.slice(0, 220).trimEnd() + "\u2026" : context;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={open ? () => { setOpen(false); setTimeout(() => { setCopied(false); setOpened(false); }, 200); } : ask}
        style={{ display: "flex", alignItems: "center", gap: 5, background: open ? T.slate100 : T.blue, color: open ? T.blue : T.white, border: open ? `1px solid ${T.blue}` : "1px solid transparent", borderRadius: 7, padding: small ? "5px 10px" : "7px 13px", fontSize: small ? 10 : 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
      >\u26a1 Ask Claude</button>
      {open && (
        <div role="dialog" aria-label="Ask Claude" style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, zIndex: 60, width: 300, background: T.white, border: `1px solid ${T.slate100}`, borderRadius: 12, boxShadow: "0 12px 32px rgba(15,23,42,0.16)", padding: 14, textAlign: "left" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#16A34A", marginBottom: 4 }}>
            {copied ? "\u2713 Context copied to your clipboard" : "Copying\u2026"}
          </div>
          <div style={{ fontSize: 11, color: T.slate500, marginBottom: 8, lineHeight: 1.5 }}>
            This is what Claude will see \u2014 your data from this screen.
          </div>
          <div style={{ fontSize: 11, lineHeight: 1.55, color: T.slate500, background: T.slate100, borderRadius: 8, padding: 9, maxHeight: 92, overflow: "hidden", whiteSpace: "pre-wrap" }}>{preview}</div>
          <div style={{ marginTop: 10 }}>
            {!opened ? (
              <button onClick={go} style={{ width: "100%", background: T.blue, color: T.white, border: "none", borderRadius: 8, padding: "8px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                Open Claude.ai &amp; paste
              </button>
            ) : demoMode ? (
              <div style={{ background: "#FFFBEB", border: "1px solid #D9770633", borderRadius: 8, padding: "8px 11px", fontSize: 11, lineHeight: 1.55, color: "#D97706" }}>
                <strong>Demo mode.</strong> On a real BCC this opens the agent's own Claude.ai, ready to paste.
              </div>
            ) : (
              <div style={{ background: "#ECFDF3", border: "1px solid #16A34A33", borderRadius: 8, padding: "8px 11px", fontSize: 11, lineHeight: 1.55, color: "#16A34A" }}>
                \u2713 Claude.ai opened in a new tab \u2014 paste with Ctrl/\u2318+V.
              </div>
            )}
          </div>
          <div style={{ marginTop: 9, fontSize: 10, color: T.slate400, lineHeight: 1.5 }}>
            Opens <em>your</em> Claude account \u2014 your subscription, your Project.
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Memory Card ──────────────────────────────────────────────
const MemoryCard = ({ item, categoryConfig, onEdit }) => {
  const [expanded, setExpanded] = useState(false);
  const lines = item.content.split("\n").filter(Boolean);
  const preview = lines.slice(0, 3).join("\n");
  const hasMore = lines.length > 3;

  return (
    <div style={{
      background: T.white,
      border: `1px solid ${T.slate200}`,
      borderRadius: 12,
      overflow: "hidden",
      borderLeft: `4px solid ${categoryConfig.color}`,
    }}>
      {/* Card Header */}
      <div style={{
        padding: "12px 14px",
        display: "flex", alignItems: "flex-start",
        justifyContent: "space-between", gap: 8,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.slate800, marginBottom: 2 }}>
            {item.title}
          </div>
          <div style={{ fontSize: 10, color: T.slate400 }}>
            Added by {item.added_by} · {item.source.replace(/_/g," ")}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <AskBtn size="small" context={`Memory context — ${item.title}:\n\n${item.content}\n\nHelp me review and update this information if needed.`} />
          <button
            onClick={() => onEdit(item)}
            style={{
              padding: "5px 10px", fontSize: 10, fontWeight: 600,
              color: T.slate600, background: T.slate100,
              border: `1px solid ${T.slate200}`,
              borderRadius: 6, cursor: "pointer",
            }}
          >Edit</button>
        </div>
      </div>

      {/* Content */}
      <div style={{
        padding: "0 14px 12px",
        fontSize: 12, color: T.slate700,
        lineHeight: 1.7,
        whiteSpace: "pre-line",
      }}>
        {expanded ? item.content : preview}
        {hasMore && (
          <button
            onClick={() => setExpanded(e => !e)}
            style={{
              display: "block", marginTop: 6,
              fontSize: 11, color: T.blue,
              background: "none", border: "none",
              cursor: "pointer", padding: 0, fontWeight: 500,
            }}
          >
            {expanded ? "Show less ↑" : `Show more (${lines.length - 3} more lines) ↓`}
          </button>
        )}
      </div>
    </div>
  );
};

// ─── Edit Modal ───────────────────────────────────────────────
const EditModal = ({ item, categories, onSave, onCancel, onDelete }) => {
  const [title,    setTitle]    = useState(item?.title   || "");
  const [content,  setContent]  = useState(item?.content || "");
  const [category, setCategory] = useState(item?.category || "business_rules");
  const isNew = !item?.id;

  return (
    <div style={{
      position: "fixed", inset: 0,
      background: "rgba(15,23,42,0.5)",
      display: "flex", alignItems: "center",
      justifyContent: "center", zIndex: 1000,
      padding: 20,
    }}>
      <div style={{
        background: T.white, borderRadius: 16,
        width: "100%", maxWidth: 560,
        boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
        overflow: "hidden",
      }}>
        {/* Modal Header */}
        <div style={{
          padding: "16px 20px",
          borderBottom: `1px solid ${T.slate200}`,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.slate900 }}>
            {isNew ? "Add Memory" : "Edit Memory"}
          </div>
          <button onClick={onCancel} style={{
            background: "none", border: "none",
            fontSize: 18, color: T.slate400,
            cursor: "pointer", lineHeight: 1,
          }}>×</button>
        </div>

        {/* Modal Body */}
        <div style={{ padding: "20px" }}>
          {/* Category */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: T.slate600, display: "block", marginBottom: 6 }}>
              CATEGORY
            </label>
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              style={{
                width: "100%", padding: "8px 10px",
                fontSize: 12, color: T.slate800,
                background: T.white,
                border: `1px solid ${T.slate200}`,
                borderRadius: 8, outline: "none",
              }}
            >
              {categories.map(c => (
                <option key={c.id} value={c.id}>{c.icon} {c.label}</option>
              ))}
            </select>
          </div>

          {/* Title */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: T.slate600, display: "block", marginBottom: 6 }}>
              TITLE
            </label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Short descriptive title..."
              style={{
                width: "100%", padding: "8px 10px",
                fontSize: 12, color: T.slate800,
                border: `1px solid ${T.slate200}`,
                borderRadius: 8, outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          {/* Content */}
          <div style={{ marginBottom: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: T.slate600, display: "block", marginBottom: 6 }}>
              CONTENT
            </label>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="Enter the information Claude should remember..."
              rows={8}
              style={{
                width: "100%", padding: "10px",
                fontSize: 12, color: T.slate800,
                border: `1px solid ${T.slate200}`,
                borderRadius: 8, outline: "none",
                resize: "vertical", lineHeight: 1.6,
                fontFamily: "inherit",
                boxSizing: "border-box",
              }}
            />
          </div>
          <div style={{ fontSize: 10, color: T.slate400, marginBottom: 16 }}>
            Claude reads this in every conversation. Be specific and complete.
          </div>
        </div>

        {/* Modal Footer */}
        <div style={{
          padding: "12px 20px",
          borderTop: `1px solid ${T.slate200}`,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <div>
            {!isNew && (
              <button
                onClick={() => onDelete(item.id)}
                style={{
                  padding: "7px 14px", fontSize: 11, fontWeight: 600,
                  color: T.red, background: T.redLt,
                  border: "none", borderRadius: 7, cursor: "pointer",
                }}
              >Delete</button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onCancel}
              style={{
                padding: "7px 14px", fontSize: 11, fontWeight: 600,
                color: T.slate600, background: T.slate100,
                border: "none", borderRadius: 7, cursor: "pointer",
              }}
            >Cancel</button>
            <button
              onClick={() => onSave({ ...item, title, content, category })}
              disabled={!title.trim() || !content.trim()}
              style={{
                padding: "7px 16px", fontSize: 11, fontWeight: 600,
                color: T.white, background: T.navy,
                border: "none", borderRadius: 7, cursor: "pointer",
                opacity: (!title.trim() || !content.trim()) ? 0.5 : 1,
              }}
            >Save Memory</button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Category Sidebar ─────────────────────────────────────────
const CategorySidebar = ({ categories, activeCategory, counts, onChange }) => (
  <div style={{
    width: 200, flexShrink: 0,
    display: "flex", flexDirection: "column", gap: 4,
  }}>
    <button
      onClick={() => onChange("all")}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "9px 12px", borderRadius: 8, cursor: "pointer",
        background: activeCategory === "all" ? T.navy : "transparent",
        border: `1px solid ${activeCategory === "all" ? T.navy : T.slate200}`,
        fontSize: 12, fontWeight: activeCategory === "all" ? 600 : 400,
        color: activeCategory === "all" ? T.white : T.slate600,
        textAlign: "left",
      }}
    >
      <span>All Memories</span>
      <span style={{
        fontSize: 10, fontWeight: 700,
        background: activeCategory === "all" ? "rgba(255,255,255,0.2)" : T.slate200,
        color: activeCategory === "all" ? T.white : T.slate600,
        borderRadius: 10, padding: "1px 7px",
      }}>{counts.all}</span>
    </button>

    {categories.map(cat => {
      const active = activeCategory === cat.id;
      return (
        <button
          key={cat.id}
          onClick={() => onChange(cat.id)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "9px 12px", borderRadius: 8, cursor: "pointer",
            background: active ? cat.colorLt : "transparent",
            border: `1px solid ${active ? cat.color : T.slate200}`,
            fontSize: 12, fontWeight: active ? 600 : 400,
            color: active ? cat.color : T.slate600,
            textAlign: "left",
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontSize: 14 }}>{cat.icon}</span>
            <span>{cat.label}</span>
          </span>
          <span style={{
            fontSize: 10, fontWeight: 600,
            background: active ? cat.color : T.slate100,
            color: active ? T.white : T.slate500,
            borderRadius: 10, padding: "1px 7px",
          }}>{counts[cat.id] || 0}</span>
        </button>
      );
    })}
  </div>
);

// ─── Main Module ──────────────────────────────────────────────
export default function PersistentMemory() {
  // Live-fetch from Supabase persistent_memory table
  const { data: liveMemories, loading: memoryLoading } = useSupabaseTable(
    "persistent_memory", AGENCY_ID, { orderBy: "updated_at", ascending: false }
  );
  const [memories,        setMemories]        = useState([]);
  useEffect(() => {
    if (Array.isArray(liveMemories)) setMemories(liveMemories);
  }, [liveMemories]);
  const [activeCategory,  setActiveCategory]  = useState("all");
  const [editingItem,     setEditingItem]      = useState(null);
  const [showNewModal,    setShowNewModal]     = useState(false);
  const [searchQuery,     setSearchQuery]      = useState("");

  // Counts per category
  const counts = {
    all: memories.filter(m => m.is_active !== false).length,
    ...Object.fromEntries(
      CATEGORIES.map(c => [c.id, memories.filter(m => m.category === c.id && m.is_active !== false).length])
    ),
  };

  // Filtered memories
  const filtered = memories.filter(m => {
    if (m.is_active === false) return false;
    if (activeCategory !== "all" && m.category !== activeCategory) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return m.title.toLowerCase().includes(q) || m.content.toLowerCase().includes(q);
    }
    return true;
  });

  // Grouped by category for display
  const grouped = CATEGORIES.reduce((acc, cat) => {
    const items = filtered.filter(m => m.category === cat.id);
    if (items.length) acc[cat.id] = items;
    return acc;
  }, {});

  const handleSave = async (item) => {
    try {
      if (item.id) {
        const { data: updated, error } = await supabase
          .from("persistent_memory")
          .update({
            title: item.title,
            content: item.content,
            category: item.category,
          })
          .eq("id", item.id)
          .select()
          .single();
        if (error) {
          console.error("Update memory failed:", error);
          alert("Update memory failed: " + error.message);
          return;
        }
        setMemories(prev => prev.map(m => m.id === item.id ? updated : m));
      } else {
        const { data: newRow, error } = await supabase
          .from("persistent_memory")
          .insert({
            agency_id: AGENCY_ID,
            category: item.category,
            title: item.title,
            content: item.content,
            is_active: true,
            added_by: "owner",
            source: "manual",
          })
          .select()
          .single();
        if (error) {
          console.error("Add memory failed:", error);
          alert("Add memory failed: " + error.message);
          return;
        }
        setMemories(prev => [...prev, newRow]);
      }
      setEditingItem(null);
      setShowNewModal(false);
    } catch (e) {
      console.error("Save memory error:", e);
      alert("Save memory failed: " + (e?.message || String(e)));
    }
  };

  const handleDelete = async (id) => {
    try {
      const { error } = await supabase
        .from("persistent_memory")
        .update({ is_active: false })
        .eq("id", id);
      if (error) {
        console.error("Delete memory failed:", error);
        alert("Delete memory failed: " + error.message);
        return;
      }
      setMemories(prev => prev.map(m => m.id === id ? { ...m, is_active: false } : m));
      setEditingItem(null);
    } catch (e) {
      console.error("Delete memory error:", e);
      alert("Delete memory failed: " + (e?.message || String(e)));
    }
  };

  const allContext = memories
    .filter(m => m.is_active !== false)
    .map(m => `[${m.title}]\n${m.content}`)
    .join("\n\n---\n\n");

  return (
    <div>
      {/* Module Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: T.slate900, letterSpacing: "-0.02em" }}>
            Persistent Memory
          </div>
          <div style={{ fontSize: 12, color: T.slate500, marginTop: 3 }}>
            {counts.all} memory entries · Claude reads all of these in every conversation
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <AskBtn
            context={`Here is my complete agency memory context — everything I want you to know about my business:\n\n${allContext}\n\nPlease review this and tell me: (1) Is anything missing? (2) Is anything outdated? (3) Are there any inconsistencies you notice?`}
          />
          <button
            onClick={() => setShowNewModal(true)}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              background: T.navy, color: T.white,
              border: "none", borderRadius: 8,
              padding: "8px 16px", fontSize: 12, fontWeight: 600,
              cursor: "pointer",
            }}
          >+ Add Memory</button>
        </div>
      </div>

      {/* How Claude Uses This — Info Banner */}
      <div style={{
        background: T.blueLt,
        border: `1px solid ${T.blue}20`,
        borderLeft: `4px solid ${T.blue}`,
        borderRadius: 10, padding: "12px 16px",
        marginBottom: 20,
        display: "flex", alignItems: "flex-start", gap: 12,
      }}>
        <span style={{ fontSize: 20, flexShrink: 0 }}>💡</span>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: T.navy, marginBottom: 3 }}>
            How Claude uses this memory
          </div>
          <div style={{ fontSize: 11, color: T.slate600, lineHeight: 1.6 }}>
            Every entry here is passed to Claude as context at the start of each conversation. Claude uses it to give you answers that are specific to your agency — not generic advice. The more complete and accurate this memory is, the more useful your Claude becomes. You and Claude can both add, edit, and update these entries at any time.
          </div>
        </div>
      </div>

      {/* Search */}
      <div style={{ marginBottom: 16 }}>
        <input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search memories..."
          style={{
            width: "100%", padding: "9px 14px",
            fontSize: 12, color: T.slate800,
            border: `1px solid ${T.slate200}`,
            borderRadius: 9, outline: "none",
            boxSizing: "border-box",
            background: T.white,
          }}
        />
      </div>

      {/* Body — Sidebar + Cards */}
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>

        {/* Category Sidebar */}
        <CategorySidebar
          categories={CATEGORIES}
          activeCategory={activeCategory}
          counts={counts}
          onChange={setActiveCategory}
        />

        {/* Memory Cards */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 20 }}>
          {filtered.length === 0 && (
            <div style={{
              textAlign: "center", padding: "40px 20px",
              color: T.slate400, fontSize: 13,
            }}>
              {searchQuery ? `No memories match "${searchQuery}"` : "No memories in this category yet."}
            </div>
          )}

          {activeCategory === "all"
            ? CATEGORIES.map(cat => {
                const items = grouped[cat.id];
                if (!items?.length) return null;
                return (
                  <div key={cat.id}>
                    {/* Category Group Header */}
                    <div style={{
                      display: "flex", alignItems: "center", gap: 8,
                      marginBottom: 10,
                    }}>
                      <span style={{ fontSize: 16 }}>{cat.icon}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: T.slate700 }}>{cat.label}</span>
                      <div style={{ flex: 1, height: 1, background: T.slate200, marginLeft: 4 }} />
                      <span style={{ fontSize: 11, color: T.slate400 }}>{items.length} {items.length === 1 ? "entry" : "entries"}</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {items.map(item => (
                        <MemoryCard
                          key={item.id}
                          item={item}
                          categoryConfig={cat}
                          onEdit={setEditingItem}
                        />
                      ))}
                    </div>
                  </div>
                );
              })
            : (() => {
                const cat = CATEGORIES.find(c => c.id === activeCategory);
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {filtered.map(item => (
                      <MemoryCard
                        key={item.id}
                        item={item}
                        categoryConfig={cat}
                        onEdit={setEditingItem}
                      />
                    ))}
                  </div>
                );
              })()
          }
        </div>
      </div>

      {/* Edit Modal */}
      {(editingItem || showNewModal) && (
        <EditModal
          item={editingItem}
          categories={CATEGORIES}
          onSave={handleSave}
          onCancel={() => { setEditingItem(null); setShowNewModal(false); }}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
