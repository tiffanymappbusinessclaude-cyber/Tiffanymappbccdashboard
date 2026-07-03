import { useMemo, useState, useEffect, useRef } from "react";

// ============================================================
// BCC PLAYBOOK & GUIDE MODULE v1.0
// Business Command Center — State Farm Agent Edition
// Built by Imaginary Farms LLC · imaginary-farms.com
// DATA: 100% client-side. No DB dependency.
// ============================================================

const T = {navy:"#1B2B4B",blue:"#2D7DD2",blueLt:"#EFF6FF",green:"#10B981",greenLt:"#D1FAE5",amber:"#F59E0B",amberLt:"#FEF3C7",red:"#EF4444",redLt:"#FEE2E2",coral:"#F97066",coralLt:"#FEF1EE",purple:"#7C3AED",purpleLt:"#EDE9FE",cream:"#FFF8F0",slate50:"#F8FAFC",slate100:"#F1F5F9",slate200:"#E2E8F0",slate300:"#CBD5E1",slate400:"#94A3B8",slate500:"#64748B",slate600:"#475569",slate700:"#334155",slate800:"#1E293B",slate900:"#0F172A",white:"#FFFFFF"};

const iconPaths = {
  sparkles:  <path d="M12 3l1.9 4.3L18 9l-4.1 1.7L12 15l-1.9-4.3L6 9l4.1-1.7L12 3zM19 14l.8 1.7L21.5 17l-1.7.8L19 20l-.8-2.2L16 17l1.7-1.3L19 14zM5 15l.6 1.4L7 17l-1.4.7L5 19l-.6-1.3L3 17l1.4-.6L5 15z" />,
  info:      <><circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>,
  warn:      <><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>,
  compass:   <><circle cx="12" cy="12" r="10" /><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" /></>,
  bookOpen:  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />,
  search:    <><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>,
  x:         <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>,
  chevronDown: <polyline points="6 9 12 15 18 9" />,
  chevronsDown:<><polyline points="7 13 12 18 17 13" /><polyline points="7 6 12 11 17 6" /></>,
  chevronsUp:  <><polyline points="17 11 12 6 7 11" /><polyline points="17 18 12 13 7 18" /></>,
};
function Icon({ name, size = 16, color = "currentColor", strokeWidth = 1.75, fill = "none" }) {
  const p = iconPaths[name];
  if (!p) return null;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>{p}</svg>;
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
  const ask = async () => { setOpen(true); try { await navigator.clipboard.writeText(context); setCopied(true); } catch { setCopied(true); } };
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

const INTRO_CALLOUTS = [
  {
    variant: 'info',
    title: 'How the “Try in Claude” button works.',
    body: 'Every prompt in this Playbook has a blue Try in Claude button next to it. Click it, and the prompt is copied to your clipboard and Claude.ai opens in a new tab. Switch to that tab, paste with Cmd+V (Mac) or Ctrl+V (Windows), and hit Enter. That\'s it. Keep your Claude.ai account signed in on the same browser and you\'ll be one paste away from any prompt in this guide.',
  },
  {
    variant: 'brand',
    title: 'You\'re not training a specific Claude — you\'re teaching your database.',
    body: 'Every rule you give it, every preference, every correction gets stored in the BCC database that lives underneath every Claude conversation you\'ll ever have. Lose your laptop? Your BCC\'s memory is intact. Start a fresh chat next Tuesday? Everything you\'ve taught it is already there. Visit the Wiki & System Map module anytime to see exactly what your database knows.',
  },
  {
    variant: 'brand',
    title: 'Your Claude is your partner and your network engineer.',
    body: 'During the build phase, every session where our team drove your Claude to construct your database, write your automation recipes, test your webapp, and connect your accounts was recorded to your Claude\'s persistent memory. Your Claude didn\'t just receive a working system — your Claude co-built it, and remembers how every piece got there. That\'s why this system is self-healing and ever-evolving: when something drifts, your Claude has the context to fix it; when your business changes, your Claude has the context to extend the system with you. It\'s a full operating system with AI intelligence baked in — not a tool you use, but a partner who runs alongside you.',
  },
  {
    variant: 'warn',
    title: 'What your assistant will never do.',
    body: 'Send an email, move money, change your prices, or commit to anything on your behalf without you reviewing and approving. Keeping you in the loop on anything that touches the outside world is built into how Claude works by Anthropic — it\'s not a rule anyone added.',
  },
  {
    variant: 'brand',
    title: 'What this Playbook actually is.',
    body: 'During your first weeks with the BCC, Rebecca was your coach — talking to your Claude on your behalf while you got oriented. This guide is her handing you the microphone. Every prompt in here is something she was doing behind the scenes. You\'ve owned the whole system since day one — this just shows you how to drive it directly.',
  },
];

const PLAYBOOK_DATA = [
  {
    id: 's0',
    title: 'Your first 30 minutes',
    subtitle: 'Pick 3 of these 5 · Get familiar with your BCC before anything else',
    intro: 'Brand new to your BCC? Don\'t try to master everything at once. Pick any 3 of these 5 prompts and run them today. That\'s enough to make it feel like a working partner — not a mystery box you paid for.',
    callouts: null,
    subsections: null,
    prompts: [
      { title: 'Introduce yourself and tell me what you already know', tag: 'Foundation', text: 'Introduce yourself. Tell me what you already know about my agency — my team, my numbers, how I run things. Then walk me through how you and the Imaginary Farms team built this system for us. I want to hear it in your voice as my partner and my network engineer. Don\'t quiz me, just show me what\'s already loaded and what you\'re carrying from the build.', prompt: 'Introduce yourself. Tell me what you already know about my agency — my team, my numbers, how I run things. Then walk me through how you and the Imaginary Farms team built this system for us. I want to hear it in your voice as my partner and my network engineer. Don\'t quiz me, just show me what\'s already loaded and what you\'re carrying from the build.', tip: 'This is the “oh, it actually knows my agency” moment. Do this one first.' },
      { title: 'Give me a tour of my dashboard', tag: 'Foundation', text: 'Give me a tour of what\'s on my dashboard right now. For each section, tell me in plain English what it\'s showing and what I\'d typically use it for. Highlight anything that looks off or that I should look at first.', prompt: 'Give me a tour of what\'s on my dashboard right now. For each section, tell me in plain English what it\'s showing and what I\'d typically use it for. Highlight anything that looks off or that I should look at first.' },
      { title: 'Teach me three things you should remember', tag: 'Persistent Memory', text: 'Ask me three questions that would help you understand my agency better — the kind of things you\'d want to know if we were working together. Once I answer, save what I tell you as rules so you\'ll remember them in every future conversation.', prompt: 'Ask me three questions that would help you understand my agency better — the kind of things you\'d want to know if we were working together. Once I answer, save what I tell you as rules so you\'ll remember them in every future conversation.', tip: 'Seeds the Persistent Memory habit from day one. This is what turns a generic Claude into your Claude.' },
      { title: 'Show me what\'s automated already', tag: 'Automations', text: 'Give me a plain-English list of what\'s already running automatically for my agency — what pulls in documents, what watches for things, what posts on my behalf. When each one runs, and what I\'d notice if it stopped working.', prompt: 'Give me a plain-English list of what\'s already running automatically for my agency — what pulls in documents, what watches for things, what posts on my behalf. When each one runs, and what I\'d notice if it stopped working.' },
      { title: 'Walk me through my Wiki & System Map', tag: 'Persistent Memory', text: 'Walk me through what\'s in my Wiki & System Map right now. What data is stored, what systems are connected, what\'s ready to use. Point out anything I might not realize is already set up.', prompt: 'Walk me through what\'s in my Wiki & System Map right now. What data is stored, what systems are connected, what\'s ready to use. Point out anything I might not realize is already set up.' },
    ],
  },
  {
    id: 's1',
    title: 'Every day',
    subtitle: 'Open your BCC each morning · one to two minutes',
    intro: 'These are the “morning coffee” prompts. Two or three minutes with your assistant and you know what matters today.',
    callouts: null,
    subsections: null,
    prompts: [
      { title: 'Morning briefing', tag: 'Dashboard', text: 'Good morning. Give me a quick rundown of what I need to pay attention to today. Check my calendar, anything new since yesterday, what\'s due this week, and anything else you think I should know about the agency right now. Keep it short — just the important stuff.', prompt: 'Good morning. Give me a quick rundown of what I need to pay attention to today. Check my calendar, anything new since yesterday, what\'s due this week, and anything else you think I should know about the agency right now. Keep it short — just the important stuff.' },
      { title: 'Who do I need to follow up with today?', tag: 'Tasks & People', text: 'Who do I need to follow up with? Check my emails, my tasks, and anything open. Give me a short list, most important first, and tell me what to say or do for each one.', prompt: 'Who do I need to follow up with? Check my emails, my tasks, and anything open. Give me a short list, most important first, and tell me what to say or do for each one.' },
      { title: 'Help me prep for a meeting', tag: 'People', text: 'I have a meeting with [name or who they are] in about [how long from now]. Help me get ready. What do I know about them? What should I bring up? What questions might they ask? Make it quick and practical.', prompt: 'I have a meeting with [name or who they are] in about [how long from now]. Help me get ready. What do I know about them? What should I bring up? What questions might they ask? Make it quick and practical.' },
      { title: 'Draft an email for me', tag: 'People', text: 'Write me an email to [who]. The point of the email is [what you want to say or accomplish]. Keep it friendly and professional — the way I normally talk. Not too long. Sign it from me.', prompt: 'Write me an email to [who]. The point of the email is [what you want to say or accomplish]. Keep it friendly and professional — the way I normally talk. Not too long. Sign it from me.', tip: 'Your assistant drafts the email. You read it, tweak if needed, then hit send yourself. It never sends on its own.' },
    ],
  },
  {
    id: 's2',
    title: 'Every week',
    subtitle: 'Friday wrap-up or Monday planning · five to ten minutes',
    intro: 'A weekly rhythm keeps things from piling up. Pick the day that works for you and ask your assistant to run through these.',
    callouts: null,
    subsections: null,
    prompts: [
      { title: 'How did the week go?', tag: 'Financials', text: 'Walk me through how this week went. New business written, anything notable on retention, where we are versus where I want to be. Don\'t sugarcoat — tell me what\'s working and what isn\'t. Plain English, no spreadsheet talk.', prompt: 'Walk me through how this week went. New business written, anything notable on retention, where we are versus where I want to be. Don\'t sugarcoat — tell me what\'s working and what isn\'t. Plain English, no spreadsheet talk.' },
      { title: 'Where am I on AIPP?', tag: 'Financials', text: 'How am I tracking on AIPP right now? Where do I stand versus where I need to be at this point in the year? What do I need to do between now and the end of the quarter to stay on target? Give me the honest picture.', prompt: 'How am I tracking on AIPP right now? Where do I stand versus where I need to be at this point in the year? What do I need to do between now and the end of the quarter to stay on target? Give me the honest picture.', tip: 'Run this weekly. AIPP can sneak up — your assistant tracks it from your Comp Recaps so you don\'t have to.' },
      { title: 'What\'s coming up I should know about?', tag: 'Tax & Alerts', text: 'What\'s coming up in the next 2 weeks that I should know about? Deadlines, renewals, taxes due, things I haven\'t responded to, anything on the calendar I might have forgotten. Give me a heads-up.', prompt: 'What\'s coming up in the next 2 weeks that I should know about? Deadlines, renewals, taxes due, things I haven\'t responded to, anything on the calendar I might have forgotten. Give me a heads-up.' },
      { title: 'Check on the team', tag: 'People', text: 'Quick check on the team. Anything I should know about my staff right now? Time-off requests, anyone behind on something I assigned, anyone I haven\'t talked to in a while. Just the highlights.', prompt: 'Quick check on the team. Anything I should know about my staff right now? Time-off requests, anyone behind on something I assigned, anyone I haven\'t talked to in a while. Just the highlights.' },
    ],
  },
  {
    id: 's3',
    title: 'Every month',
    subtitle: 'First week of the new month · fifteen to twenty minutes',
    intro: 'Once a month, do a slightly deeper check. Most of these you\'d want to do with your CPA or office manager rather than alone.',
    callouts: null,
    subsections: null,
    prompts: [
      { title: 'How did last month close out?', tag: 'Financials', text: 'Walk me through how last month closed. Revenue, expenses, payroll, comp — how did we do versus the month before and versus where I expected to be? Any surprises? What should I carry into this month? Give me the version I\'d use in a conversation with my CPA — real numbers, plain language.', prompt: 'Walk me through how last month closed. Revenue, expenses, payroll, comp — how did we do versus the month before and versus where I expected to be? Any surprises? What should I carry into this month? Give me the version I\'d use in a conversation with my CPA — real numbers, plain language.', tip: 'The “CPA version” framing is the trick — it tells your assistant the right level of detail without you having to spell it out.' },
      { title: 'Compare this year so far to last year', tag: 'Financials', text: 'How is the agency doing this year compared to last year at the same point? Revenue, new business, retention, payroll, the big lines. What\'s up, what\'s down, and what\'s that telling us?', prompt: 'How is the agency doing this year compared to last year at the same point? Revenue, new business, retention, payroll, the big lines. What\'s up, what\'s down, and what\'s that telling us?' },
      { title: 'Tax check-in', tag: 'Tax', text: 'What tax obligations are coming up in the next 90 days? Anything I need to start preparing for now, anything due soon, anything I\'ve already paid I should make sure is recorded. Treat me like the business owner, not the accountant.', prompt: 'What tax obligations are coming up in the next 90 days? Anything I need to start preparing for now, anything due soon, anything I\'ve already paid I should make sure is recorded. Treat me like the business owner, not the accountant.' },
      { title: 'Find a document', tag: 'Documents', text: 'Find me [what you\'re looking for — e.g. “last year\'s W-2 totals” or “the lease for the office” or “March bank statement”]. Give me a link I can click.', prompt: 'Find me [what you\'re looking for — e.g. last year\'s W-2 totals or the lease for the office or March bank statement]. Give me a link I can click.' },
    ],
  },
  {
    id: 's4',
    title: 'Whenever you need it',
    subtitle: 'No schedule — just things that come up',
    intro: 'These don\'t have a rhythm — they\'re for moments that come up unexpectedly. Save them somewhere handy.',
    callouts: null,
    subsections: null,
    prompts: [
      { title: 'Help me think through something', tag: 'Strategy', text: 'Something came up and I want to think it through. Here\'s the situation: [describe it in your own words — as much detail as you want]. What are my options? What would you do? What am I not thinking about? Be straight with me.', prompt: 'Something came up and I want to think it through. Here\'s the situation: [describe it in your own words — as much detail as you want]. What are my options? What would you do? What am I not thinking about? Be straight with me.', tip: 'For decisions, awkward situations, staff issues, or anything you\'d normally bring to a trusted advisor.' },
      { title: 'Talk through a difficult conversation', tag: 'People', text: 'I need to have a conversation with [name or who they are] about [the situation]. Help me think through how to handle it. What should I say? What tone? What am I trying to come out of it with? I want to do this right.', prompt: 'I need to have a conversation with [name or who they are] about [the situation]. Help me think through how to handle it. What should I say? What tone? What am I trying to come out of it with? I want to do this right.' },
      { title: 'Make sense of a document', tag: 'Documents', text: '[Paste the document or upload it] Read this and tell me — in plain English — what it is, what it means for me, and anything I need to do or watch out for. Skip the legalese.', prompt: '[Paste the document or upload it] Read this and tell me — in plain English — what it is, what it means for me, and anything I need to do or watch out for. Skip the legalese.' },
      { title: 'Draft a social post', tag: 'Social', text: 'Draft a social media post about [what you want to post about]. Keep it in my voice — friendly, professional, not too “salesy.” A soft call to action at the end. Save it as a draft so I can look at it before it goes anywhere.', prompt: 'Draft a social media post about [what you want to post about]. Keep it in my voice — friendly, professional, not too salesy. A soft call to action at the end. Save it as a draft so I can look at it before it goes anywhere.', tip: 'For Instagram, your assistant saves the draft and you post manually (Instagram doesn\'t allow scheduled posts). For Facebook and LinkedIn, you can schedule.' },
    ],
  },
  {
    id: 's5',
    title: 'By module',
    subtitle: 'Deeper coverage of what your assistant can do across each part of the dashboard',
    intro: 'Your BCC is organized into modules. This section gives you a few useful prompts for each one — beyond the daily rhythm above. Skim for the parts of your dashboard you use most.',
    callouts: null,
    prompts: null,
    subsections: [
      { title: 'Dashboard', prompts: [
        { title: 'What needs my attention right now?', tag: 'Dashboard', text: 'Look at my dashboard and tell me what needs my attention right now. Don\'t list everything — just the things that are off-track, overdue, or close to a deadline. Top 3 to 5.', prompt: 'Look at my dashboard and tell me what needs my attention right now. Don\'t list everything — just the things that are off-track, overdue, or close to a deadline. Top 3 to 5.' },
        { title: 'Show me the headline numbers', tag: 'Dashboard', text: 'Give me the headline numbers for the agency right now. Month-to-date revenue, year-to-date revenue, AIPP progress, and anything else you\'d put on a one-page summary for me.', prompt: 'Give me the headline numbers for the agency right now. Month-to-date revenue, year-to-date revenue, AIPP progress, and anything else you\'d put on a one-page summary for me.' },
      ]},
      { title: 'Financials', prompts: [
        { title: 'Walk me through the P&L', tag: 'Financials', text: 'Walk me through last month\'s profit and loss in plain English. Don\'t read me line items — tell me the story. What earned money, what cost money, what\'s the bottom line, and what should I pay attention to.', prompt: 'Walk me through last month\'s profit and loss in plain English. Don\'t read me line items — tell me the story. What earned money, what cost money, what\'s the bottom line, and what should I pay attention to.' },
        { title: 'Where is the money going?', tag: 'Financials', text: 'Where is my money going this year? What are the top 5 expense categories, what percentage of revenue does each represent, and is anything growing faster than I\'d want?', prompt: 'Where is my money going this year? What are the top 5 expense categories, what percentage of revenue does each represent, and is anything growing faster than I\'d want?' },
        { title: 'Cash flow check', tag: 'Financials', text: 'What does my cash position look like? Money in, money out, what I should expect over the next 30 days. Just the picture I\'d want before making any big spending decisions.', prompt: 'What does my cash position look like? Money in, money out, what I should expect over the next 30 days. Just the picture I\'d want before making any big spending decisions.' },
      ]},
      { title: 'Documents', prompts: [
        { title: 'Find something by topic', tag: 'Documents', text: 'Find me anything we have about [topic — e.g. “the lease renewal” or “Sarah\'s payroll history” or “Q1 bank statements”]. Give me clickable links.', prompt: 'Find me anything we have about [topic — e.g. the lease renewal or Sarah\'s payroll history or Q1 bank statements]. Give me clickable links.' },
        { title: 'What documents are missing?', tag: 'Documents', text: 'Look at what documents we have for this year. Anything missing for the months we\'ve already closed? Anything I should be chasing down from a vendor or payroll provider?', prompt: 'Look at what documents we have for this year. Anything missing for the months we\'ve already closed? Anything I should be chasing down from a vendor or payroll provider?' },
      ]},
      { title: 'Persistent Memory', prompts: [
        { title: 'Show me what you remember', tag: 'Persistent Memory', text: 'Show me what rules and preferences you currently have for my agency. Group them by topic — pricing, team, communication style, anything else. I want to see what you know.', prompt: 'Show me what rules and preferences you currently have for my agency. Group them by topic — pricing, team, communication style, anything else. I want to see what you know.', tip: 'A great quarterly habit. Look at the list, prune anything that\'s no longer true, add anything that\'s changed.' },
        { title: 'Remember a new rule', tag: 'Persistent Memory', text: 'Remember this from now on: [the rule]. A few examples of rules I might give you: — “We never quote auto without bundling home.” — “Don\'t recommend any policy under $500 in annual premium — it\'s not worth the time.” — “All life applications get reviewed by me before they go out.” — “If anyone asks about my commercial program, route them to Mike.”', prompt: 'Remember this from now on: [the rule].' },
        { title: 'Forget something', tag: 'Persistent Memory', text: 'Forget what you have remembered about [topic or specific rule]. That\'s no longer how we do it. Going forward, [the new rule or context, if there is one].', prompt: 'Forget what you have remembered about [topic or specific rule]. That\'s no longer how we do it. Going forward, [the new rule or context, if there is one].' },
        { title: 'Show me my Wiki & System Map', tag: 'Wiki & System Map', text: 'Open my Wiki & System Map and give me a guided tour. What\'s stored, what\'s connected, what\'s running. Point out anything I haven\'t set up yet that would make the BCC more useful.', prompt: 'Open my Wiki & System Map and give me a guided tour. What\'s stored, what\'s connected, what\'s running. Point out anything I haven\'t set up yet that would make the BCC more useful.', tip: 'The Wiki & System Map is your visual view of what your database knows. Great to check after a big teaching session.' },
      ]},
      { title: 'Compliance & Regulatory', prompts: [
        { title: 'What\'s coming up on compliance?', tag: 'Compliance', text: 'What compliance items are coming up in the next 60 days? License renewals, CE hours, EO renewals, AL9 acknowledgments, anything else. Sorted by date, with the ones I should start on now flagged.', prompt: 'What compliance items are coming up in the next 60 days? License renewals, CE hours, EO renewals, AL9 acknowledgments, anything else. Sorted by date, with the ones I should start on now flagged.' },
        { title: 'Check my license status', tag: 'Compliance', text: 'Show me the current status of every license I hold — the state, the license number, the expiration date, and CE requirements outstanding. Flag anything I need to act on in the next 90 days.', prompt: 'Show me the current status of every license I hold — the state, the license number, the expiration date, and CE requirements outstanding. Flag anything I need to act on in the next 90 days.' },
        { title: 'Is this social post AL9-compliant?', tag: 'Compliance', text: 'I\'m about to post this on social: [paste the post]. Look at it through an AL9 lens. Anything I should change before it goes up — specific premium quotes, comparative claims, guarantees, anything that would raise a flag?', prompt: 'I\'m about to post this on social: [paste the post]. Look at it through an AL9 lens. Anything I should change before it goes up — specific premium quotes, comparative claims, guarantees, anything that would raise a flag?' },
      ]},
      { title: 'Automations', prompts: [
        { title: 'What\'s automated for me?', tag: 'Automations', text: 'What\'s running automatically for my agency right now? Give me a list in plain English — what each one does and when it runs. No technical names.', prompt: 'What\'s running automatically for my agency right now? Give me a list in plain English — what each one does and when it runs. No technical names.' },
        { title: 'Did anything fail recently?', tag: 'Automations', text: 'Has anything that should have run automatically failed in the last few days? If so, what was it supposed to do, and what (if anything) do I need to do about it?', prompt: 'Has anything that should have run automatically failed in the last few days? If so, what was it supposed to do, and what (if anything) do I need to do about it?' },
      ]},
      { title: 'Alerts & Notifications', prompts: [
        { title: 'What\'s flagged right now?', tag: 'Alerts', text: 'What\'s currently flagged for my attention? Sort it by urgency — what\'s actually time-sensitive versus what\'s just FYI. For each one, tell me what I should do about it.', prompt: 'What\'s currently flagged for my attention? Sort it by urgency — what\'s actually time-sensitive versus what\'s just FYI. For each one, tell me what I should do about it.' },
      ]},
      { title: 'Tasks & Goals', prompts: [
        { title: 'What\'s on my plate?', tag: 'Tasks', text: 'What\'s on my plate right now? Sort it by urgency. Don\'t include things that aren\'t really mine to do — only what I personally need to take action on.', prompt: 'What\'s on my plate right now? Sort it by urgency. Don\'t include things that aren\'t really mine to do — only what I personally need to take action on.' },
        { title: 'How am I tracking against my goals?', tag: 'Goals', text: 'How am I tracking against my goals for the year? For each one, tell me where I am, where I should be at this point, and what\'s likely to happen if I keep going at the current pace.', prompt: 'How am I tracking against my goals for the year? For each one, tell me where I am, where I should be at this point, and what\'s likely to happen if I keep going at the current pace.' },
      ]},
      { title: 'Social Media', prompts: [
        { title: 'What\'s queued up to post?', tag: 'Social', text: 'What posts are currently queued up to go out? Show me what\'s scheduled for the next 2 weeks across all my social channels.', prompt: 'What posts are currently queued up to go out? Show me what\'s scheduled for the next 2 weeks across all my social channels.' },
        { title: 'Draft a series of posts', tag: 'Social', text: 'Draft me [number] social media posts about [topic or theme] for [which platform — Facebook, LinkedIn, Instagram]. Friendly, in my voice, not pushy. Save them as drafts — I\'ll review each one before anything posts.', prompt: 'Draft me [number] social media posts about [topic or theme] for [which platform — Facebook, LinkedIn, Instagram]. Friendly, in my voice, not pushy. Save them as drafts — I\'ll review each one before anything posts.' },
      ]},
      { title: 'HR & People', prompts: [
        { title: 'Show me a team member\'s info', tag: 'People', text: 'Tell me everything you have on [team member\'s name]. Role, when they started, their current compensation, time-off balance, anything I\'ve noted about their performance.', prompt: 'Tell me everything you have on [team member\'s name]. Role, when they started, their current compensation, time-off balance, anything I\'ve noted about their performance.' },
        { title: 'Track a performance note', tag: 'People', text: 'Make a performance note for [team member\'s name]. [What happened — could be positive or a concern]. Date it today. I want to be able to find this when review time comes.', prompt: 'Make a performance note for [team member\'s name]. [What happened — could be positive or a concern]. Date it today. I want to be able to find this when review time comes.' },
        { title: 'Payroll history check', tag: 'People', text: 'Show me [team member\'s name]\'s payroll history for the year. Gross, taxes, take-home, any overtime or commissions. Tell me if anything looks unusual compared to their normal pattern.', prompt: 'Show me [team member\'s name]\'s payroll history for the year. Gross, taxes, take-home, any overtime or commissions. Tell me if anything looks unusual compared to their normal pattern.' },
      ]},
      { title: 'Tax Center', prompts: [
        { title: 'What\'s due in the next 90 days?', tag: 'Tax', text: 'What tax obligations are coming up in the next 90 days? List them with the amount estimated (if you know it), the deadline, and which entity it\'s for. Sorted by date.', prompt: 'What tax obligations are coming up in the next 90 days? List them with the amount estimated (if you know it), the deadline, and which entity it\'s for. Sorted by date.' },
        { title: 'Record a tax payment I made', tag: 'Tax', text: 'I just made a tax payment. Record it: [amount, what it was for, which entity, date paid, how it was paid]. Match it to the obligation it was for if you can find it.', prompt: 'I just made a tax payment. Record it: [amount, what it was for, which entity, date paid, how it was paid]. Match it to the obligation it was for if you can find it.' },
      ]},
      { title: 'Settings', prompts: [
        { title: 'Show me my email templates', tag: 'Settings', text: 'Show me the email templates currently set up for my agency. What do we use, what does each one say, and when do they fire? I want to know what\'s going out under my name.', prompt: 'Show me the email templates currently set up for my agency. What do we use, what does each one say, and when do they fire? I want to know what\'s going out under my name.' },
      ]},
    ],
  },
  {
    id: 's6',
    title: 'Feeding your source documents',
    subtitle: 'Comp Recap, Deductions, Bank & Credit Card statements, Payroll reports',
    intro: 'Your BCC has automation recipes that quietly find and process your key source documents in the background — they pull attachments from your Gmail, process them into the database, save the file to your Google Drive, and archive the original email. In practice, most of the work is already done before you touch it.',
    callouts: null,
    subsections: null,
    prompts: [
      { title: 'Did my Comp Recap process correctly?', tag: 'Comp Recap', text: 'The Comp Recap for [month] should have processed automatically. Confirm it landed, tell me what the totals were, and make sure my AIPP number and any producer-level scoring is reflecting the new data. If anything looks off, tell me before I go looking.', prompt: 'The Comp Recap for [month] should have processed automatically. Confirm it landed, tell me what the totals were, and make sure my AIPP number and any producer-level scoring is reflecting the new data. If anything looks off, tell me before I go looking.' },
      { title: 'Did my Deductions statement process?', tag: 'Deductions', text: 'Check that the [month] Deductions statement was processed. Give me the net compensation math — gross comp minus deductions — and confirm my books reflect the deducted amounts correctly. Flag anything unusual compared to a typical month.', prompt: 'Check that the [month] Deductions statement was processed. Give me the net compensation math — gross comp minus deductions — and confirm my books reflect the deducted amounts correctly. Flag anything unusual compared to a typical month.' },
      { title: 'Did my bank & credit card statements process?', tag: 'Statements', text: 'Confirm that my bank and credit card statements for [month] made it into the BCC. Give me the ending balances, tell me if reconciliation completed cleanly, and flag any transactions that got miscategorized or look unusual.', prompt: 'Confirm that my bank and credit card statements for [month] made it into the BCC. Give me the ending balances, tell me if reconciliation completed cleanly, and flag any transactions that got miscategorized or look unusual.' },
      { title: 'Did my payroll report process?', tag: 'Payroll', text: 'Check that the [month] payroll report was processed. Show me total gross payroll, employer taxes, and net paid, and confirm each active team member\'s numbers match what you\'d expect. Flag anyone whose pay looks off compared to their pattern.', prompt: 'Check that the [month] payroll report was processed. Show me total gross payroll, employer taxes, and net paid, and confirm each active team member\'s numbers match what you\'d expect. Flag anyone whose pay looks off compared to their pattern.' },
      { title: 'The automation didn\'t catch a document — help me file it manually', tag: 'Fallback', text: 'The [document type — e.g. “August Comp Recap” or “corporate card statement”] didn\'t come through the automation. I\'m attaching it now. Add it to my Documents library, file it correctly, pull out the important numbers, and update anything in the dashboard that should shift because of it. Tell me what changed.', prompt: 'The [document type] didn\'t come through the automation. I\'m attaching it now. Add it to my Documents library, file it correctly, pull out the important numbers, and update anything in the dashboard that should shift because of it. Tell me what changed.', tip: 'Use this when a document arrives by hand-off, a bank doesn\'t email statements, or the automation misses one. Otherwise, let the automations do their thing.' },
    ],
  },
  {
    id: 's7',
    title: 'Adding & updating data',
    subtitle: 'How to keep your BCC current as your business changes',
    intro: 'Almost any update follows the same shape: “Here\'s what changed: ___. Please update ___ accordingly.” Your assistant figures out where it lives, what tables to touch, and what else might need to update because of it. You don\'t need to know the technical names.',
    callouts: null,
    subsections: null,
    prompts: [
      { title: 'Correct a number that\'s wrong', tag: 'Financials', text: 'The number for [describe what\'s wrong — e.g. “March payroll” or “the Q1 commercial revenue line”] is off. The right number is [correct figure], and the source is [where you\'re getting the right number — bank statement, payroll provider, CPA, etc.]. Update it, and tell me what other numbers in the dashboard might shift as a result so I\'m not surprised.', prompt: 'The number for [describe what\'s wrong] is off. The right number is [correct figure], and the source is [where you\'re getting the right number]. Update it, and tell me what other numbers in the dashboard might shift as a result so I\'m not surprised.', tip: 'Your assistant won\'t silently overwrite financial data. It\'ll confirm the change and tell you what else is affected. Always work from a source document, not memory.' },
      { title: 'Add a new team member', tag: 'People', text: 'Add a new team member: [full name], role [their role], started [start date], base pay [salary or hourly], working [full-time / part-time / hours per week]. Anything else worth knowing: [license held, what they handle, who they report to, etc.].', prompt: 'Add a new team member: [full name], role [their role], started [start date], base pay [salary or hourly], working [full-time / part-time / hours per week]. Anything else worth knowing: [license held, what they handle, who they report to, etc.].' },
      { title: 'Mark someone as having left', tag: 'People', text: '[Team member\'s name] has left the agency, last day [date]. Mark them as inactive — don\'t delete their history. [Any context worth keeping for the record].', prompt: '[Team member\'s name] has left the agency, last day [date]. Mark them as inactive — don\'t delete their history. [Any context worth keeping for the record].' },
      { title: 'Record a comp or pay change', tag: 'People', text: '[Team member\'s name] is getting a comp change effective [date]. New base: [amount]. [Reason — raise, promotion, market adjustment]. Note this in their record so the next payroll picks up the new rate.', prompt: '[Team member\'s name] is getting a comp change effective [date]. New base: [amount]. [Reason — raise, promotion, market adjustment]. Note this in their record so the next payroll picks up the new rate.' },
      { title: 'Add a new tax obligation I just learned about', tag: 'Tax', text: 'Add a new tax obligation to track: [what it is] for [which entity], due [date], estimated amount [$ if known]. Remind me about 2 weeks before it\'s due.', prompt: 'Add a new tax obligation to track: [what it is] for [which entity], due [date], estimated amount [$ if known]. Remind me about 2 weeks before it\'s due.' },
      { title: 'Update or add a goal', tag: 'Goals', text: '[Either “Add a new goal” or “Update my goal for”]: [what the goal is — e.g. “$95,000 AIPP for the year” or “30 life policies written this year”]. Track it against [which metric or data]. [Deadline if it has one].', prompt: '[Either Add a new goal or Update my goal for]: [what the goal is]. Track it against [which metric or data]. [Deadline if it has one].' },
      { title: 'Update my agency profile', tag: 'Settings', text: 'Update my agency profile: [what\'s changing — agent code, license info, office address, business entity name, anything official]. Effective [date].', prompt: 'Update my agency profile: [what\'s changing]. Effective [date].' },
    ],
  },
  {
    id: 's8',
    title: 'Asking Claude to do work',
    subtitle: 'Beyond answering questions — actually getting things done',
    intro: 'A lot of what your assistant can do isn\'t answering questions — it\'s preparing things you can then review and use. Reports, drafts, summaries, suggested responses, scheduled posts. Tell it what you want produced, who it\'s for, and what format or length.',
    callouts: null,
    subsections: null,
    prompts: [
      { title: 'Prepare my monthly close report', tag: 'Financials', text: 'Prepare my monthly close report for [month and year]. I want a short version (2 pages or less) covering: revenue with comparison to prior month and prior year, expenses with anything unusual highlighted, payroll, comp recap, where we are on AIPP, and any open items I should address. Format it for printing.', prompt: 'Prepare my monthly close report for [month and year]. I want a short version (2 pages or less) covering: revenue with comparison to prior month and prior year, expenses with anything unusual highlighted, payroll, comp recap, where we are on AIPP, and any open items I should address. Format it for printing.' },
      { title: 'Build me a CPA package', tag: 'Financials · Tax', text: 'Put together a CPA package for [the period]. Include: P&L, balance sheet, general ledger, payroll summary, any tax payments made this period, and a one-page summary I can hand to my CPA. Plain numbers, no commentary. Save it as a package I can download or share.', prompt: 'Put together a CPA package for [the period]. Include: P&L, balance sheet, general ledger, payroll summary, any tax payments made this period, and a one-page summary I can hand to my CPA. Plain numbers, no commentary. Save it as a package I can download or share.' },
      { title: 'Draft my team meeting agenda', tag: 'People', text: 'Draft an agenda for my team meeting this [day]. Pull from what\'s been going on lately — production numbers, anything pending, customer issues we\'ve been working through. Keep it under [length]. End with one or two questions I should ask the team.', prompt: 'Draft an agenda for my team meeting this [day]. Pull from what\'s been going on lately — production numbers, anything pending, customer issues we\'ve been working through. Keep it under [length]. End with one or two questions I should ask the team.' },
      { title: 'Write me a client retention letter', tag: 'People', text: 'A customer [name or describe them] told us they\'re thinking about switching. Help me write a response. They\'ve been with us [how long]. [Anything you know about why they\'re considering leaving]. Warm, not desperate, and don\'t promise anything I can\'t deliver.', prompt: 'A customer [name or describe them] told us they\'re thinking about switching. Help me write a response. They\'ve been with us [how long]. [Anything you know about why they\'re considering leaving]. Warm, not desperate, and don\'t promise anything I can\'t deliver.' },
      { title: 'Build a list for outreach', tag: 'People · Financials', text: 'Build me a list of [describe — e.g. “auto customers who don\'t have home with us” or “customers with renewals in the next 60 days”]. Sort by [premium / how long with us / something else]. Top [number]. For each one, give me a one-line reason they\'re a good candidate to call.', prompt: 'Build me a list of [describe]. Sort by [premium / how long with us / something else]. Top [number]. For each one, give me a one-line reason they\'re a good candidate to call.', tip: 'Your assistant builds the list. You make the calls. It won\'t reach out to customers on its own.' },
      { title: 'Write up a performance review', tag: 'People', text: 'Help me write a performance review for [team member\'s name] for the [period]. Pull from any performance notes I\'ve left throughout the year, their payroll/commission record, and anything else relevant. Give me a draft that\'s honest and specific — strengths, areas to develop, what I\'m asking of them next. Not a generic HR template.', prompt: 'Help me write a performance review for [team member\'s name] for the [period]. Pull from any performance notes I\'ve left throughout the year, their payroll/commission record, and anything else relevant. Give me a draft that\'s honest and specific — strengths, areas to develop, what I\'m asking of them next. Not a generic HR template.' },
      { title: 'Compare two options for me', tag: 'Strategy', text: 'I\'m deciding between [option A] and [option B]. Help me think through it. What does each one cost (money, time, effort)? What does each one get me? What am I not seeing? Give me a recommendation at the end — be straight with me.', prompt: 'I\'m deciding between [option A] and [option B]. Help me think through it. What does each one cost (money, time, effort)? What does each one get me? What am I not seeing? Give me a recommendation at the end — be straight with me.' },
    ],
  },
  {
    id: 's9',
    title: 'Teaching Claude over time',
    subtitle: 'The single most powerful habit · how your BCC gets sharper',
    intro: 'Stop thinking of your assistant as a tool you\'re using. Start thinking of it as a colleague you\'re training. Every time you correct it, refine its output, or tell it a preference — say “remember this” and it sticks. Over six months, you\'ll have something that genuinely sounds like your business partner.',
    callouts: null,
    subsections: null,
    prompts: [
      { title: 'Teach a hard rule', tag: 'Persistent Memory', text: 'Remember this as a hard rule from now on: [the rule]. Hard rules are things you\'d never want me to bend. Good examples: — “Never quote auto without bundling home and asking about life.” — “Always copy my CPA on financial summaries over $50K.” — “No social media posts ever mention specific premium amounts.”', prompt: 'Remember this as a hard rule from now on: [the rule].' },
      { title: 'Teach a preference', tag: 'Persistent Memory', text: 'A preference to keep in mind: [your preference]. Preferences are softer than rules — things you\'d usually want but can be overridden. Examples: — “Keep my emails under 150 words unless the situation needs more.” — “When you draft for me, lean a little warmer than corporate.” — “On Mondays, lead with what\'s coming up. On Fridays, lead with what happened.”', prompt: 'A preference to keep in mind: [your preference].' },
      { title: 'Teach your voice', tag: 'Persistent Memory', text: 'Here\'s an example of how I\'d actually write to a customer. Use this as a reference for my voice going forward: [paste an email or message you\'ve written, in your real voice]. Notice how warm or formal I am, sentence length, how I sign off, whether I use first names. Try to match this when you draft for me.', prompt: 'Here\'s an example of how I\'d actually write to a customer. Use this as a reference for my voice going forward: [paste an email or message you\'ve written, in your real voice]. Notice how warm or formal I am, sentence length, how I sign off, whether I use first names. Try to match this when you draft for me.', tip: 'One or two of these in your first month is worth a lot. Your assistant goes from “competent generic email” to “sounds like me.”' },
      { title: 'Teach a team member\'s responsibilities', tag: 'Persistent Memory', text: 'Remember this about [team member\'s name]: they handle [what they own]. When someone asks for them or something comes up about [topic], that\'s their territory, not mine. Route accordingly when you draft for me.', prompt: 'Remember this about [team member\'s name]: they handle [what they own]. When someone asks for them or something comes up about [topic], that\'s their territory, not mine. Route accordingly when you draft for me.' },
      { title: 'Review and prune what you\'ve taught', tag: 'Persistent Memory', text: 'Show me everything you currently have stored as rules and preferences for my agency. Group them by topic. For each one, tell me when it was added if you can. I want to read through and remove anything that\'s outdated.', prompt: 'Show me everything you currently have stored as rules and preferences for my agency. Group them by topic. For each one, tell me when it was added if you can. I want to read through and remove anything that\'s outdated.', tip: 'A great quarterly habit — 15 minutes pruning what your assistant remembers keeps it sharp.' },
    ],
  },
  {
    id: 's10',
    title: 'What NOT to ask Claude',
    subtitle: 'Where the boundaries are · protects you and your customers',
    intro: 'Your BCC assistant is powerful and versatile — but there are places where it\'s the wrong tool. Knowing the boundaries protects your book, keeps you compliant, and prevents surprises. Keep these in mind:',
    callouts: [
      { title: 'Don\'t ask Claude to generate customer-facing quotes.', body: 'State Farm\'s rating tools are the only authoritative source. Your BCC can help you prep, follow up, and think strategically about pricing — but rating is not its job.' },
      { title: 'Don\'t ask Claude to bind coverage or make policy changes.', body: 'Anything that changes a customer\'s insurance record has to go through the SF system with you at the wheel. Full stop.' },
      { title: 'Don\'t paste sensitive customer information into the chat.', body: 'Social Security numbers, driver\'s license numbers, credit card numbers, medical information — keep those out. Your BCC doesn\'t need them to be helpful.' },
      { title: 'Don\'t ask Claude to make payments or move money.', body: 'It won\'t, and it shouldn\'t — Claude is built by Anthropic to stay out of banking and money movement entirely. If a prompt anywhere seems to ask it to touch banking, close that conversation and start fresh.' },
      { title: 'Don\'t ask Claude to send anything customer-facing without you reviewing.', body: 'Draft, review, send. Never draft and send in the same breath — the review step is the whole point.' },
    ],
    subsections: null,
    prompts: [],
  },
  {
    id: 's11',
    title: 'Referring another agent',
    subtitle: 'When a fellow agent asks what this is',
    intro: 'Once you\'ve been running your BCC for a while, other agents will ask what it is. Here\'s a prompt that helps you explain it without turning it into a sales pitch — in your own words, in your own voice.',
    callouts: null,
    subsections: null,
    prompts: [
      { title: 'Help me explain my BCC to a fellow agent', tag: 'Referral', text: 'A fellow agent asked me what my Business Command Center actually is and what it does for me. Help me explain it in a way that would make sense to them — no sales pitch, no jargon, just the honest version. Focus on what I use it for most, what surprised me about it, and what parts have made the biggest difference in how I run the agency. If it fits how I actually feel, work in the honest part most people miss at first: Imaginary Farms drove my Claude through the build. My Claude co-built the system and remembers all of it. My Claude is my partner and my network engineer — the system is self-healing and keeps evolving because my Claude has the context to run it with me. Imaginary Farms handed us the jumpstart. My Claude runs the day-to-day.', prompt: 'A fellow agent asked me what my Business Command Center actually is and what it does for me. Help me explain it in a way that would make sense to them — no sales pitch, no jargon, just the honest version. Focus on what I use it for most, what surprised me about it, and what parts have made the biggest difference in how I run the agency. If it fits how I actually feel, work in the honest part most people miss at first: Imaginary Farms drove my Claude through the build. My Claude co-built the system and remembers all of it. My Claude is my partner and my network engineer — the system is self-healing and keeps evolving because my Claude has the context to run it with me. Imaginary Farms handed us the jumpstart. My Claude runs the day-to-day.', tip: 'If your fellow agent wants to know more after that, send them to imaginary-farms.com — they\'ll take it from there.' },
    ],
  },
  {
    id: 's12',
    title: 'When something looks wrong',
    subtitle: 'Most things you can fix yourself · here\'s how',
    intro: 'Software has off days. Numbers don\'t match what you expected. A document didn\'t get filed. An automation didn\'t fire. Don\'t panic — most of these resolve in two or three minutes if you ask the right way.',
    callouts: null,
    subsections: null,
    prompts: [
      { title: 'The all-purpose “fix it” prompt', tag: 'Troubleshooting', text: 'Something looks off. Here\'s what I\'m seeing: [describe it — what part of the dashboard, what you expected, what you\'re seeing instead. Attach a screenshot if you can]. Take a look and tell me what\'s going on. If you can fix it, fix it and tell me what you did. If you can\'t, tell me what\'s broken and what I should do next.', prompt: 'Something looks off. Here\'s what I\'m seeing: [describe it — what part of the dashboard, what you expected, what you\'re seeing instead. Attach a screenshot if you can]. Take a look and tell me what\'s going on. If you can fix it, fix it and tell me what you did. If you can\'t, tell me what\'s broken and what I should do next.', tip: 'Most issues resolve here. Your assistant can usually identify the problem and either fix it or tell you exactly who to talk to.' },
      { title: 'My numbers don\'t match what I expected', tag: 'Financials', text: 'The number for [what] shows as [what the dashboard says], but I\'m expecting more like [what you think it should be] based on [your source]. Walk me through how you calculated that number. Show me the underlying data, and help me figure out where the difference is. Don\'t guess — show me actual rows.', prompt: 'The number for [what] shows as [what the dashboard says], but I\'m expecting more like [what you think it should be] based on [your source]. Walk me through how you calculated that number. Show me the underlying data, and help me figure out where the difference is. Don\'t guess — show me actual rows.' },
      { title: 'A document is missing', tag: 'Documents', text: 'I\'m looking for [what document — name it and the period] but I don\'t see it in the Documents library. Check whether: (1) it came in by email but wasn\'t filed, (2) it\'s filed under a different name, or (3) we genuinely don\'t have it yet. Tell me what you find.', prompt: 'I\'m looking for [what document — name it and the period] but I don\'t see it in the Documents library. Check whether: (1) it came in by email but wasn\'t filed, (2) it\'s filed under a different name, or (3) we genuinely don\'t have it yet. Tell me what you find.' },
      { title: 'An automation didn\'t run when it should have', tag: 'Automations', text: 'The [name of the automation — or describe what it does] was supposed to run [when] but I don\'t think it did. Check what happened. If it failed, tell me why in plain English and what we should do about it.', prompt: 'The [name of the automation — or describe what it does] was supposed to run [when] but I don\'t think it did. Check what happened. If it failed, tell me why in plain English and what we should do about it.' },
      { title: 'An email draft didn\'t get created', tag: 'Troubleshooting', text: 'I asked you to draft an email earlier, but I don\'t see it in my email drafts. Check whether it actually got created — if not, what went wrong, and please try it again now.', prompt: 'I asked you to draft an email earlier, but I don\'t see it in my email drafts. Check whether it actually got created — if not, what went wrong, and please try it again now.' },
      { title: 'An alert doesn\'t make sense to me', tag: 'Alerts', text: 'I\'m looking at this alert: [paste the alert text or describe it]. I don\'t fully understand what it\'s telling me. Explain it in plain English — what triggered it, what it actually means for the agency, and whether it needs me to do something or it\'s just informational.', prompt: 'I\'m looking at this alert: [paste the alert text or describe it]. I don\'t fully understand what it\'s telling me. Explain it in plain English — what triggered it, what it actually means for the agency, and whether it needs me to do something or it\'s just informational.' },
    ],
  },
];

const CALLOUT_STYLES = {
  brand:    { bg: T.coralLt,  border: T.coral,  iconColor: T.coral,  iconName: "sparkles" },
  info:     { bg: T.blueLt,   border: T.blue,   iconColor: T.blue,   iconName: "info" },
  warn:     { bg: T.amberLt,  border: T.amber,  iconColor: T.amber,  iconName: "warn" },
  coaching: { bg: T.cream,    border: T.navy,   iconColor: T.navy,   iconName: "compass" },
};

function Callout({ variant, title, body }) {
  const s = CALLOUT_STYLES[variant] || CALLOUT_STYLES.info;
  return (
    <div style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 10, padding: "14px 16px", margin: "10px 0", display: "flex", alignItems: "flex-start", gap: 12 }}>
      <div style={{ flexShrink: 0, marginTop: 2 }}><Icon name={s.iconName} size={18} color={s.iconColor} strokeWidth={2} /></div>
      <div style={{ flex: 1 }}>
        {title && <div style={{ fontSize: 13, fontWeight: 700, color: T.slate900, marginBottom: 4, lineHeight: 1.35 }}>{title}</div>}
        {body && <div style={{ fontSize: 12, color: T.slate600, lineHeight: 1.6 }}>{body}</div>}
      </div>
    </div>
  );
}

function PromptCard({ prompt, sectionTitle, subsectionTitle, highlight }) {
  const q = prompt.prompt || prompt.text || "";
  const context = `From the BCC Playbook & Guide.\nSection: ${sectionTitle || ""}\nSubsection: ${subsectionTitle || ""}\nPrompt title: ${prompt.title || ""}\n\n---\n\n${q}`;
  const bodyEls = highlight ? highlight(prompt.text || q) : (prompt.text || q);
  return (
    <div style={{ background: T.white, border: `1px solid ${T.slate200}`, borderRadius: 10, padding: 14, marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: T.slate900, lineHeight: 1.35 }}>{highlight ? highlight(prompt.title || "") : (prompt.title || "")}</span>
          {prompt.tag && <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: T.blue, background: T.blueLt, padding: "2px 7px", borderRadius: 12 }}>{prompt.tag}</span>}
        </div>
        <AskBtn context={context} size="small" />
      </div>
      <div style={{ fontSize: 12, color: T.slate600, lineHeight: 1.65, background: T.slate50, padding: "10px 12px", borderRadius: 7, borderLeft: `3px solid ${T.blue}` }}>{bodyEls}</div>
    </div>
  );
}

function matchesQuery(prompt, q) {
  if (!q) return true;
  const hay = [prompt.title, prompt.text, prompt.prompt, prompt.tag].filter(Boolean).join(" ").toLowerCase();
  return hay.includes(q);
}

function makeHighlighter(q) {
  if (!q) return null;
  const needle = q.toLowerCase();
  return (text) => {
    if (!text || typeof text !== "string") return text;
    const lower = text.toLowerCase();
    const parts = [];
    let i = 0, k = 0;
    while (i < text.length) {
      const idx = lower.indexOf(needle, i);
      if (idx === -1) { parts.push(text.slice(i)); break; }
      if (idx > i) parts.push(text.slice(i, idx));
      parts.push(<mark key={`h-${k++}`} style={{ background: T.amberLt, color: T.slate900, padding: "0 2px", borderRadius: 2 }}>{text.slice(idx, idx + needle.length)}</mark>);
      i = idx + needle.length;
    }
    return parts;
  };
}

function Section({ section, query, forceOpen, highlight }) {
  const shouldOpen = Boolean(forceOpen || (section.id === "s0"));
  const subsections = section.subsections || [];
  const bareprompts = section.prompts || [];
  const filteredSubs = subsections.map((sub) => ({ ...sub, prompts: (sub.prompts || []).filter((p) => matchesQuery(p, query)) })).filter((sub) => (sub.prompts || []).length > 0 || matchesQuery({ title: sub.title, text: sub.intro || "" }, query));
  const filteredBare = bareprompts.filter((p) => matchesQuery(p, query));
  const totalMatches = filteredSubs.reduce((n, s) => n + (s.prompts || []).length, 0) + filteredBare.length;
  if (query && totalMatches === 0) return null;
  return (
    <details open={shouldOpen || Boolean(query)} style={{ background: T.white, border: `1px solid ${T.slate200}`, borderRadius: 12, marginBottom: 14, overflow: "hidden" }}>
      <summary style={{ padding: "14px 18px", cursor: "pointer", listStyle: "none", background: T.slate50, borderBottom: `1px solid ${T.slate200}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: T.slate900, letterSpacing: "-0.01em" }}>{highlight ? highlight(section.title || "") : section.title}</div>
          {section.subtitle && <div style={{ fontSize: 11, color: T.slate500, marginTop: 3, lineHeight: 1.4 }}>{section.subtitle}</div>}
        </div>
        <span className="playbook-chevron" style={{ color: T.slate500, transition: "transform 0.2s", flexShrink: 0 }}><Icon name="chevronDown" size={18} /></span>
      </summary>
      <div style={{ padding: "16px 18px" }}>
        {section.intro && <div style={{ fontSize: 12, color: T.slate600, lineHeight: 1.65, marginBottom: 14, background: T.slate50, padding: "10px 12px", borderRadius: 7 }}>{highlight ? highlight(section.intro) : section.intro}</div>}
        {section.callouts && section.callouts.map((c, ci) => <Callout key={ci} variant={c.variant} title={c.title} body={c.body} />)}
        {filteredBare.map((p, pi) => <PromptCard key={`bp-${pi}`} prompt={p} sectionTitle={section.title} subsectionTitle="" highlight={highlight} />)}
        {filteredSubs.map((sub, si) => (
          <div key={`sub-${si}`} style={{ marginTop: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6, color: T.slate500, marginBottom: 4 }}>{highlight ? highlight(sub.title || "") : sub.title}</div>
            {sub.intro && <div style={{ fontSize: 12, color: T.slate600, lineHeight: 1.65, marginBottom: 10 }}>{highlight ? highlight(sub.intro) : sub.intro}</div>}
            {(sub.prompts || []).map((p, pi) => <PromptCard key={`sp-${si}-${pi}`} prompt={p} sectionTitle={section.title} subsectionTitle={sub.title} highlight={highlight} />)}
          </div>
        ))}
      </div>
    </details>
  );
}

export default function PlaybookGuide() {
  const [query, setQuery] = useState("");
  const [expandAll, setExpandAll] = useState(false);
  const [collapseAll, setCollapseAll] = useState(0);
  const highlight = useMemo(() => makeHighlighter(query.trim().toLowerCase()), [query]);
  const forceOpen = Boolean(query) || expandAll;
  const collapseEverything = () => { setExpandAll(false); setCollapseAll((k) => k + 1); };
  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 26, fontWeight: 800, color: T.slate900, letterSpacing: "-0.02em", display: "flex", alignItems: "center", gap: 10 }}>
          <Icon name="bookOpen" size={24} color={T.blue} strokeWidth={2} /> Playbook &amp; Guide
        </div>
        <div style={{ fontSize: 13, color: T.slate500, marginTop: 4, lineHeight: 1.5 }}>Every prompt in here has an "Ask Claude" button. It copies a context-wrapped version to your clipboard so you can paste directly into your Claude.ai tab.</div>
      </div>
      <div style={{ marginBottom: 16 }}>{INTRO_CALLOUTS.map((c, ci) => <Callout key={ci} variant={c.variant} title={c.title} body={c.body} />)}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 18, background: T.white, border: `1px solid ${T.slate200}`, borderRadius: 10, padding: 10 }}>
        <div style={{ position: "relative", flex: "1 1 260px", maxWidth: 500 }}>
          <div style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: T.slate400 }}><Icon name="search" size={14} /></div>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all prompts, titles, tags…" style={{ width: "100%", padding: "8px 32px 8px 32px", fontSize: 12, border: `1px solid ${T.slate200}`, borderRadius: 7, background: T.white, color: T.slate900, boxSizing: "border-box" }} />
          {query && <button onClick={() => setQuery("")} style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", color: T.slate500, cursor: "pointer", padding: 4, display: "flex" }} aria-label="Clear search"><Icon name="x" size={14} /></button>}
        </div>
        <button onClick={() => setExpandAll(true)} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: T.white, color: T.slate700, border: `1px solid ${T.slate300}`, borderRadius: 7, padding: "7px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}><Icon name="chevronsDown" size={13} /> Expand all</button>
        <button onClick={collapseEverything} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: T.white, color: T.slate700, border: `1px solid ${T.slate300}`, borderRadius: 7, padding: "7px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}><Icon name="chevronsUp" size={13} /> Collapse all</button>
      </div>
      <div key={`sections-${collapseAll}`}>{PLAYBOOK_DATA.map((section) => <Section key={section.id} section={section} query={query.trim().toLowerCase()} forceOpen={forceOpen} highlight={highlight} />)}</div>
      <div style={{ marginTop: 24, padding: "14px 18px", background: T.slate50, border: `1px solid ${T.slate200}`, borderRadius: 10, fontSize: 11, color: T.slate500, lineHeight: 1.6, textAlign: "center" }}>Playbook content authored by Rebecca — Imaginary Farms LLC · The Claude Whisperer. Every prompt is copy-ready.</div>
      <style>{`details[open] .playbook-chevron { transform: rotate(180deg); } details summary::-webkit-details-marker { display: none; }`}</style>
    </div>
  );
}
