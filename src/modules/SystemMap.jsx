// SystemMap module: a wiki-style browser/editor for public.system_map.
// One page per row, grouped by category, full-text search, inline edit, revisions tracked.
// Pages are markdown; renderer below covers the subset we actually use:
// headings, bold, italic, inline code, fenced code blocks, bullet/numbered lists,
// tables, blockquotes, links, and paragraphs.

import { useMemo, useState } from 'react';
import {
  BookOpen, Search, Plus, Edit2, Save, X, ChevronLeft, CheckCircle2,
  Clock, Link2, FileText, AlertTriangle, RefreshCw, History,
} from 'lucide-react';

import SectionHeader from '../components/SectionHeader.jsx';
import LoadingState from '../components/LoadingState.jsx';
import EmptyState from '../components/EmptyState.jsx';
import FilterPill from '../components/FilterPill.jsx';
import PrintButton from '../components/PrintButton.jsx';
import AskClaudeButton from '../components/AskClaudeButton.jsx';
import ConfirmDeleteButton from '../components/ConfirmDeleteButton.jsx';
import { supabase } from '../lib/supabase.js';
import { useSupabaseQuery } from '../lib/hooks.js';
import { fmtDate } from '../lib/utils.js';

const CATEGORIES = [
  { key: 'all',         label: 'All' },
  { key: 'overview',    label: 'Overview' },
  { key: 'domain',      label: 'Domain' },
  { key: 'schema',      label: 'Schema' },
  { key: 'integration', label: 'Integration' },
  { key: 'automation',  label: 'Automation' },
  { key: 'decision',    label: 'Decision' },
  { key: 'runbook',     label: 'Runbook' },
  { key: 'glossary',    label: 'Glossary' },
];

const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));

// "Stale" if no verification in this many days
const STALE_DAYS = 30;

function daysSince(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Markdown renderer (minimal). Built for the wiki content shape we control;
// don't expect general-purpose markdown perfection.
// ---------------------------------------------------------------------------

function renderInline(text) {
  // Process inline patterns in a single pass. Order matters: code first so its
  // contents don't get re-processed by bold/italic/link.
  const parts = [];
  let rest = text;
  let idx = 0;
  const patterns = [
    { re: /`([^`]+)`/,           render: (m, k) => <code key={k} className="px-1 py-0.5 rounded bg-if-page text-xs font-mono">{m[1]}</code> },
    { re: /\*\*([^*]+)\*\*/,     render: (m, k) => <strong key={k}>{m[1]}</strong> },
    { re: /\*([^*]+)\*/,         render: (m, k) => <em key={k}>{m[1]}</em> },
    { re: /\[([^\]]+)\]\(([^)]+)\)/, render: (m, k) => <a key={k} href={m[2]} target="_blank" rel="noreferrer" className="text-if-blue hover:underline">{m[1]}</a> },
  ];
  while (rest.length > 0) {
    let earliest = null;
    let earliestIdx = Infinity;
    let earliestPattern = null;
    for (const p of patterns) {
      const m = p.re.exec(rest);
      if (m && m.index < earliestIdx) {
        earliest = m;
        earliestIdx = m.index;
        earliestPattern = p;
      }
    }
    if (!earliest) {
      parts.push(rest);
      break;
    }
    if (earliestIdx > 0) parts.push(rest.slice(0, earliestIdx));
    parts.push(earliestPattern.render(earliest, `inline-${idx++}`));
    rest = rest.slice(earliestIdx + earliest[0].length);
  }
  return parts;
}

function renderMarkdown(md) {
  if (!md) return null;
  const lines = md.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith('```')) {
      const langMatch = line.match(/^```(\w*)/);
      const lang = langMatch?.[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing
      blocks.push(
        <pre key={blocks.length} className="bg-if-page border border-if-line rounded-md px-3 py-2 my-3 overflow-x-auto text-xs">
          <code className="font-mono">{buf.join('\n')}</code>
          {lang && <div className="text-[10px] uppercase tracking-wide text-if-muted mt-1">{lang}</div>}
        </pre>,
      );
      continue;
    }

    // Heading
    const hMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      const text = hMatch[2];
      const cls = ['text-base font-semibold mt-4 mb-2 text-if-navy', 'text-sm font-semibold mt-3 mb-1 text-if-navy', 'text-xs font-semibold mt-2 mb-1 text-if-navy uppercase tracking-wide', 'text-xs font-semibold mt-2 mb-1 text-if-muted'][Math.min(level - 1, 3)];
      const Tag = `h${Math.min(level + 1, 6)}`;
      blocks.push(<Tag key={blocks.length} className={cls}>{renderInline(text)}</Tag>);
      i++;
      continue;
    }

    // Table (heuristic: line starts with | and next line is a divider)
    if (line.startsWith('|') && lines[i + 1]?.match(/^\|[\s\-|:]+\|?\s*$/)) {
      const header = line.split('|').slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
        i++;
      }
      blocks.push(
        <div key={blocks.length} className="my-3 overflow-x-auto">
          <table className="text-xs border-collapse w-full">
            <thead>
              <tr>
                {header.map((h, hi) => (
                  <th key={hi} className="text-left font-semibold border-b border-if-line px-2 py-1 text-if-navy">{renderInline(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="hover:bg-if-page">
                  {r.map((c, ci) => (
                    <td key={ci} className="border-b border-if-line px-2 py-1 align-top">{renderInline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Bullet list
    if (line.match(/^[-*]\s+/)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^[-*]\s+/)) {
        items.push(lines[i].replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={blocks.length} className="list-disc pl-5 my-2 text-sm space-y-1">
          {items.map((item, ii) => <li key={ii}>{renderInline(item)}</li>)}
        </ul>,
      );
      continue;
    }

    // Numbered list
    if (line.match(/^\d+\.\s+/)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s+/)) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={blocks.length} className="list-decimal pl-5 my-2 text-sm space-y-1">
          {items.map((item, ii) => <li key={ii}>{renderInline(item)}</li>)}
        </ol>,
      );
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        buf.push(lines[i].slice(2));
        i++;
      }
      blocks.push(
        <blockquote key={blocks.length} className="border-l-2 border-if-blue pl-3 my-2 text-sm text-if-muted italic">
          {buf.map((b, bi) => <div key={bi}>{renderInline(b)}</div>)}
        </blockquote>,
      );
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph: collect until blank or block-starting line
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].match(/^(#{1,4}\s|[-*]\s|\d+\.\s|>\s|```|\|)/)
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={blocks.length} className="my-2 text-sm leading-relaxed text-if-ink">
        {renderInline(buf.join(' '))}
      </p>,
    );
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function CategoryBadge({ category }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide bg-if-page text-if-muted border border-if-line">
      {CATEGORY_LABEL[category] || category}
    </span>
  );
}

function StaleIndicator({ verifiedAt }) {
  const days = daysSince(verifiedAt);
  if (days == null) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-if-warning">
        <AlertTriangle size={11} /> unverified
      </span>
    );
  }
  if (days > STALE_DAYS) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-if-warning">
        <Clock size={11} /> verified {days}d ago
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-if-muted">
      <CheckCircle2 size={11} /> verified {days}d ago
    </span>
  );
}

function PageCard({ page, onOpen }) {
  const preview = (page.body_md || '').slice(0, 200).replace(/[#*`>]/g, '').trim();
  return (
    <button
      type="button"
      onClick={() => onOpen(page.slug)}
      className="w-full text-left if-card hover:border-if-blue transition-colors cursor-pointer"
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <h4 className="text-sm font-semibold text-if-navy">{page.title}</h4>
        <CategoryBadge category={page.category} />
      </div>
      <div className="text-xs text-if-muted line-clamp-2 mb-2">{preview}{preview.length === 200 ? '…' : ''}</div>
      <div className="flex items-center justify-between">
        <code className="text-[10px] text-if-muted font-mono">{page.slug}</code>
        <StaleIndicator verifiedAt={page.last_verified_at} />
      </div>
    </button>
  );
}

function PageDetail({ slug, onBack, onEdit, onRefresh, allPagesBySlug }) {
  const { data: page, loading, error, refetch } = useSupabaseQuery(
    () => supabase.from('system_map').select('*').eq('slug', slug).single(),
    [slug],
  );
  const [bumping, setBumping] = useState(false);
  const [bumpError, setBumpError] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  if (loading) return <LoadingState label="Loading page…" />;
  if (error || !page) return <EmptyState title="Page not found" description={`No system_map row with slug "${slug}".`} />;

  async function handleVerify() {
    setBumping(true);
    setBumpError(null);
    try {
      const { error: e } = await supabase.rpc('bump_system_map_verified', {
        p_slug: slug,
        p_verified_by: (await supabase.auth.getUser())?.data?.user?.email ?? 'unknown',
      });
      if (e) throw e;
      await refetch();
      onRefresh?.();
    } catch (e) {
      setBumpError(e.message || String(e));
    } finally {
      setBumping(false);
    }
  }

  const related = (page.related_slugs || []).map((s) => ({
    slug: s,
    title: allPagesBySlug.get(s)?.title || s,
    category: allPagesBySlug.get(s)?.category || null,
  }));

  return (
    <div>
      <div className="flex items-center justify-between mb-3 if-no-print">
        <button onClick={onBack} className="if-button-ghost text-xs inline-flex items-center gap-1">
          <ChevronLeft size={14} /> Back to map
        </button>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button onClick={handleVerify} disabled={bumping} className="if-button-ghost text-xs inline-flex items-center gap-1">
            <CheckCircle2 size={14} /> {bumping ? 'Marking…' : 'Verified now'}
          </button>
          <button
            onClick={() => setHistoryOpen(true)}
            className="if-button-ghost text-xs inline-flex items-center gap-1"
            title="View past revisions of this page"
          >
            <History size={14} /> History
          </button>
          <PrintButton title={`BCC System Map — ${page.title}`} />
          <AskClaudeButton
            moduleLabel="System Map"
            subject={`Wiki page: ${page.title} (${page.slug})`}
            context={{
              slug: page.slug,
              title: page.title,
              category: page.category,
              last_verified_at: page.last_verified_at,
              last_verified_by: page.last_verified_by,
              related_slugs: page.related_slugs,
              body_md: page.body_md,
            }}
            suggestedPrompt={`Help me work through what's on this BCC wiki page. What's outdated, missing, or worth updating?`}
          />
          <button onClick={() => onEdit(page)} className="if-button-ghost text-xs inline-flex items-center gap-1">
            <Edit2 size={14} /> Edit
          </button>
        </div>
      </div>

      <div className="if-card">
        <div className="flex items-start justify-between gap-2 mb-1">
          <h2 className="text-if-navy">{page.title}</h2>
          <CategoryBadge category={page.category} />
        </div>
        <div className="flex items-center gap-3 text-[11px] text-if-muted mb-3">
          <code className="font-mono">{page.slug}</code>
          <span>•</span>
          <StaleIndicator verifiedAt={page.last_verified_at} />
          {page.last_verified_by && (
            <>
              <span>•</span>
              <span>by {page.last_verified_by}</span>
            </>
          )}
        </div>
        {bumpError && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2 mb-3">
            {bumpError}
          </div>
        )}

        <div className="prose-bcc">
          {renderMarkdown(page.body_md)}
        </div>

        {related.length > 0 && (
          <div className="mt-6 pt-3 border-t border-if-line">
            <div className="text-[11px] text-if-muted uppercase tracking-wide mb-2 inline-flex items-center gap-1">
              <Link2 size={11} /> Related pages
            </div>
            <div className="flex flex-wrap gap-2">
              {related.map((r) => (
                <button
                  key={r.slug}
                  onClick={() => onRefresh && onRefresh(r.slug)}
                  className="text-xs px-2 py-1 rounded border border-if-line bg-if-page hover:border-if-blue transition-colors text-if-navy if-no-print"
                  title={r.slug}
                >
                  {r.category && <span className="text-if-muted mr-1">[{r.category}]</span>}
                  {r.title}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {historyOpen && (
        <RevisionHistoryModal slug={page.slug} onClose={() => setHistoryOpen(false)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Revision history: shows the snapshot rows from system_map_revisions, which
// captures the pre-update state on every system_map UPDATE (trigger).
// ---------------------------------------------------------------------------

function RevisionHistoryModal({ slug, onClose }) {
  const { data, loading, error } = useSupabaseQuery(
    () => supabase
      .from('system_map_revisions')
      .select('id, slug, title, category, body_md, edited_by, edited_at, reason')
      .eq('slug', slug)
      .order('edited_at', { ascending: false })
      .limit(50),
    [slug],
  );
  const [openId, setOpenId] = useState(null);
  const rows = data ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 if-no-print">
      <div className="if-card max-w-3xl w-full max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between mb-3 flex-shrink-0">
          <h3 className="text-if-navy inline-flex items-center gap-2">
            <History size={16} /> Revision history — <code className="text-xs">{slug}</code>
          </h3>
          <button onClick={onClose} className="if-button-ghost text-xs">
            <X size={14} /> Close
          </button>
        </div>

        <div className="text-xs text-if-muted mb-3 flex-shrink-0">
          Each row is the page state BEFORE that edit (captured on UPDATE by a Postgres trigger).
          Most recent edit at top.
        </div>

        <div className="overflow-auto flex-1 min-h-0">
          {loading && <LoadingState label="Loading revisions…" />}
          {error && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              {error.message}
            </div>
          )}
          {!loading && !error && rows.length === 0 && (
            <EmptyState
              title="No revisions yet"
              description="This page hasn't been edited since it was created — there's nothing in the audit log."
            />
          )}
          <ul className="space-y-2">
            {rows.map((rev) => (
              <li key={rev.id} className="border border-if-line rounded-md">
                <button
                  type="button"
                  onClick={() => setOpenId(openId === rev.id ? null : rev.id)}
                  className="w-full text-left px-3 py-2 hover:bg-if-blue-lt transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-if-navy">{rev.title || '(untitled)'}</span>
                    <span className="text-[11px] text-if-muted">{fmtDate(rev.edited_at, 'PPpp')}</span>
                  </div>
                  <div className="text-[11px] text-if-muted mt-0.5">
                    {rev.category} • edited by {rev.edited_by || 'unknown'}
                    {rev.reason && <> • {rev.reason}</>}
                  </div>
                </button>
                {openId === rev.id && (
                  <div className="border-t border-if-line px-3 py-2 bg-if-page">
                    <pre className="text-xs font-mono whitespace-pre-wrap text-if-ink max-h-64 overflow-auto">
                      {rev.body_md || '(empty body)'}
                    </pre>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function PageEditor({ initial, onCancel, onSaved, onDeleted }) {
  const isNew = !initial;
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [category, setCategory] = useState(initial?.category ?? 'domain');
  const [bodyMd, setBodyMd] = useState(initial?.body_md ?? '');
  const [relatedSlugs, setRelatedSlugs] = useState((initial?.related_slugs ?? []).join(', '));
  const [sortOrder, setSortOrder] = useState(initial?.sort_order ?? 100);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const userEmail = (await supabase.auth.getUser())?.data?.user?.email ?? 'unknown';
      const payload = {
        slug: slug.trim(),
        title: title.trim(),
        category,
        body_md: bodyMd,
        related_slugs: relatedSlugs.split(',').map((s) => s.trim()).filter(Boolean),
        sort_order: Number(sortOrder) || 100,
        last_verified_at: new Date().toISOString(),
        last_verified_by: userEmail,
      };
      let res;
      if (isNew) {
        res = await supabase.from('system_map').insert(payload).select().single();
      } else {
        res = await supabase.from('system_map').update(payload).eq('slug', initial.slug).select().single();
      }
      if (res.error) throw res.error;
      onSaved(res.data.slug);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setSaving(true);
    setError(null);
    try {
      const { error: delErr } = await supabase
        .from('system_map')
        .delete()
        .eq('slug', initial.slug);
      if (delErr) throw delErr;
      onDeleted?.(initial.slug);
    } catch (e) {
      setError(e.message || String(e));
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <button onClick={onCancel} className="if-button-ghost text-xs inline-flex items-center gap-1">
          <X size={14} /> Cancel
        </button>
        <div className="flex items-center gap-2 flex-wrap">
          {!isNew && (
            <ConfirmDeleteButton
              onConfirm={handleDelete}
              label="Delete page"
              confirmLabel="Click again to permanently delete"
              disabled={saving}
            />
          )}
          <button
            onClick={handleSave}
            disabled={saving || !slug || !title}
            className="if-button"
          >
            <Save size={14} /> {saving ? 'Saving…' : (isNew ? 'Create page' : 'Save changes')}
          </button>
        </div>
      </div>

      <div className="if-card space-y-3">
        <h3 className="text-if-navy">{isNew ? 'New system map page' : 'Edit page'}</h3>

        {error && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-if-navy mb-1">Slug</label>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              disabled={!isNew}
              placeholder="lowercase-hyphenated-id"
              className="w-full px-2 py-1.5 border border-if-line rounded-md text-sm font-mono disabled:opacity-60 bg-if-card"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-if-navy mb-1">Sort order</label>
            <input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              className="w-full px-2 py-1.5 border border-if-line rounded-md text-sm bg-if-card"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-if-navy mb-1">Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full px-2 py-1.5 border border-if-line rounded-md text-sm bg-if-card"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-if-navy mb-1">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full px-2 py-1.5 border border-if-line rounded-md text-sm bg-if-card"
          >
            {CATEGORIES.filter((c) => c.key !== 'all').map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-if-navy mb-1">Related slugs (comma-separated)</label>
          <input
            value={relatedSlugs}
            onChange={(e) => setRelatedSlugs(e.target.value)}
            placeholder="slug-one, slug-two"
            className="w-full px-2 py-1.5 border border-if-line rounded-md text-sm font-mono bg-if-card"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-if-navy mb-1">
            Body (Markdown — headings, bold, italic, code, lists, tables, links, blockquotes)
          </label>
          <textarea
            value={bodyMd}
            onChange={(e) => setBodyMd(e.target.value)}
            rows={24}
            className="w-full px-2 py-1.5 border border-if-line rounded-md text-xs font-mono bg-if-card"
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main module
// ---------------------------------------------------------------------------

export default function SystemMap() {
  const [view, setView] = useState({ mode: 'list' }); // {mode:'list'} | {mode:'detail',slug} | {mode:'edit',page?} | {mode:'new'}
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const { data: pagesRaw, loading, error, refetch } = useSupabaseQuery(
    () => supabase
      .from('system_map')
      .select('slug, title, category, body_md, related_slugs, sort_order, last_verified_at, last_verified_by, updated_at')
      .order('category')
      .order('sort_order'),
    [refreshKey],
  );
  const pages = pagesRaw ?? [];

  const allPagesBySlug = useMemo(() => {
    const m = new Map();
    for (const p of pages) m.set(p.slug, p);
    return m;
  }, [pages]);

  // Filter pipeline
  const filtered = useMemo(() => {
    let out = pages;
    if (categoryFilter !== 'all') {
      out = out.filter((p) => p.category === categoryFilter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter(
        (p) => p.title.toLowerCase().includes(q)
            || p.slug.toLowerCase().includes(q)
            || (p.body_md || '').toLowerCase().includes(q),
      );
    }
    return out;
  }, [pages, categoryFilter, search]);

  // Group by category for list view
  const grouped = useMemo(() => {
    const m = new Map();
    for (const p of filtered) {
      if (!m.has(p.category)) m.set(p.category, []);
      m.get(p.category).push(p);
    }
    return m;
  }, [filtered]);

  // Counts for category pills
  const counts = useMemo(() => {
    const c = { all: pages.length };
    for (const p of pages) c[p.category] = (c[p.category] || 0) + 1;
    return c;
  }, [pages]);

  function openPage(slug) {
    setView({ mode: 'detail', slug });
    if (typeof window !== 'undefined') window.scrollTo(0, 0);
  }

  if (loading) return <LoadingState label="Loading system map…" />;
  if (error) {
    return (
      <div className="if-card text-sm text-red-700">
        Failed to load system_map: {error.message}
        <button onClick={() => refetch()} className="if-button-ghost text-xs ml-3"><RefreshCw size={12} /> Retry</button>
      </div>
    );
  }

  // ---- View dispatch ----

  if (view.mode === 'edit') {
    return (
      <PageEditor
        initial={view.page}
        onCancel={() => setView({ mode: 'detail', slug: view.page.slug })}
        onSaved={(slug) => {
          setRefreshKey((k) => k + 1);
          setView({ mode: 'detail', slug });
        }}
        onDeleted={() => {
          setRefreshKey((k) => k + 1);
          setView({ mode: 'list' });
        }}
      />
    );
  }

  if (view.mode === 'new') {
    return (
      <PageEditor
        initial={null}
        onCancel={() => setView({ mode: 'list' })}
        onSaved={(slug) => {
          setRefreshKey((k) => k + 1);
          setView({ mode: 'detail', slug });
        }}
      />
    );
  }

  if (view.mode === 'detail') {
    return (
      <PageDetail
        slug={view.slug}
        allPagesBySlug={allPagesBySlug}
        onBack={() => setView({ mode: 'list' })}
        onEdit={(page) => setView({ mode: 'edit', page })}
        onRefresh={(slug) => {
          setRefreshKey((k) => k + 1);
          if (slug && typeof slug === 'string') setView({ mode: 'detail', slug });
        }}
      />
    );
  }

  // ---- List view ----

  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-3">
        <SectionHeader
          title="System Map"
          subtitle="Living wiki: schemas, integrations, automations, decisions, runbooks. The steady-state truth of the BCC."
          icon={BookOpen}
        />
        <button
          onClick={() => setView({ mode: 'new' })}
          className="if-button flex-shrink-0"
        >
          <Plus size={14} /> New page
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {CATEGORIES.map((c) => (
          <FilterPill
            key={c.key}
            active={categoryFilter === c.key}
            onClick={() => setCategoryFilter(c.key)}
          >
            {c.label}
            <span className="ml-1.5 text-[10px] opacity-60">{counts[c.key] || 0}</span>
          </FilterPill>
        ))}
      </div>

      <div className="relative mb-4">
        <Search size={14} className="absolute left-2.5 top-2.5 text-if-muted pointer-events-none" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search titles, slugs, content…"
          className="w-full pl-8 pr-3 py-2 border border-if-line rounded-md text-sm bg-if-card"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No matching pages"
          description={search ? 'Try a different search or clear the filter.' : 'No pages in this category yet — create one with the New page button.'}
          icon={FileText}
        />
      ) : (
        Array.from(grouped.entries()).map(([cat, list]) => (
          <div key={cat} className="mb-6">
            <div className="text-[11px] font-semibold text-if-muted uppercase tracking-wide mb-2">
              {CATEGORY_LABEL[cat] || cat} <span className="opacity-60">({list.length})</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {list.map((p) => (
                <PageCard key={p.slug} page={p} onOpen={openPage} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
