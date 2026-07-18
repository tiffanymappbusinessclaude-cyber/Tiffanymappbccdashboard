import { useMemo } from "react";

/**
 * AskClaudeButton — opens claude.ai/new with a pre-composed prompt.
 * Sunshine State's system prompt (persistent_memory + project instructions) means every
 * new claude.ai conversation already has full agency context — this button just
 * seeds the first message with the module/subject/context the user was looking at.
 *
 * Props:
 *   moduleLabel      — string, name of the BCC module (e.g. "System Map")
 *   subject          — string, short description of what the user is looking at
 *   suggestedPrompt  — optional string, a prompt to place in the URL
 *   context          — optional object, structured context (stringified into the prompt)
 *   label            — button text (default: "Ask Claude")
 *   variant          — "solid" | "outline" (default: "solid")
 *   size             — "sm" | "md" (default: "md")
 */
export default function AskClaudeButton({
  moduleLabel,
  subject,
  suggestedPrompt,
  context,
  label = "Ask Claude",
  variant = "solid",
  size = "md",
}) {
  const href = useMemo(() => {
    const parts = [];
    if (moduleLabel) parts.push(`Module: ${moduleLabel}`);
    if (subject) parts.push(`Subject: ${subject}`);
    if (suggestedPrompt) parts.push("", suggestedPrompt);
    if (context && typeof context === "object") {
      try {
        parts.push("", "Context:", "```json", JSON.stringify(context, null, 2), "```");
      } catch (_) { /* ignore */ }
    }
    const q = parts.join("\n").trim();
    return q
      ? `https://claude.ai/new?q=${encodeURIComponent(q)}`
      : "https://claude.ai/new";
  }, [moduleLabel, subject, suggestedPrompt, context]);

  const isSolid = variant === "solid";
  const isSm = size === "sm";
  const style = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: isSm ? "4px 10px" : "8px 14px",
    fontSize: isSm ? 11 : 12,
    fontWeight: 600,
    borderRadius: 6,
    cursor: "pointer",
    textDecoration: "none",
    border: isSolid ? "none" : "1px solid #1E3A5F",
    background: isSolid ? "var(--accent-navy)" : "white",
    color: isSolid ? "white" : "var(--accent-navy)",
    whiteSpace: "nowrap",
  };

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={style}>
      <span aria-hidden="true">✨</span>
      {label}
    </a>
  );
}
