import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase.js";
import LoginPage from "./LoginPage.jsx";

// ── Design Tokens ──
const T = {
  navy:    "#1B2B4B",
  blue:    "#2D7DD2",
  blueLt:  "#EFF6FF",
  white:   "#FFFFFF",
  slate200:"#E2E8F0",
  slate400:"#94A3B8",
  slate600:"#475569",
  slate700:"#334155",
  slate900:"#0F172A",
  redLt:   "#FEE2E2",
  greenLt: "#D1FAE5",
};

/**
 * SetNewPasswordForm — shown after the user clicks the password-recovery link.
 * Supabase signs them in via the link and fires PASSWORD_RECOVERY; AuthGuard
 * watches for that event (and a ?reset=true URL marker as a backstop) and
 * blocks dashboard render until the user either sets a new password or
 * explicitly chooses to keep the current one.
 */
function SetNewPasswordForm({ onDone }) {
  const [pwd, setPwd] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const clearResetMarker = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("reset");
    const search = url.searchParams.toString();
    window.history.replaceState({}, "", url.pathname + (search ? "?" + search : ""));
  };

  const handleSubmit = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    setError("");
    if (!pwd || pwd.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (pwd !== confirm) { setError("Passwords do not match."); return; }
    setSubmitting(true);
    try {
      const { error: e1 } = await supabase.auth.updateUser({ password: pwd });
      if (e1) throw e1;
      setDone(true);
      clearResetMarker();
      setTimeout(() => onDone(), 1200);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSkip = () => { clearResetMarker(); onDone(); };

  return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:`linear-gradient(135deg, ${T.navy} 0%, #2D3F66 100%)`, padding:20 }}>
      <div style={{ width:"100%", maxWidth:420, background:T.white, borderRadius:16, boxShadow:"0 20px 50px rgba(0,0,0,0.25)", padding:36 }}>
        <div style={{ fontSize:14, fontWeight:700, color:T.slate900, marginBottom:6 }}>Set a New Password</div>
        <div style={{ fontSize:11, color:T.slate600, marginBottom:20 }}>
          You're signed in via a recovery link. Set a new password below, or skip to keep your existing one.
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom:12 }}>
            <label style={{ fontSize:11, fontWeight:600, color:T.slate700, display:"block", marginBottom:5 }}>NEW PASSWORD</label>
            <input type="password" value={pwd} onChange={e=>setPwd(e.target.value)} autoComplete="new-password" autoFocus
              style={{ width:"100%", padding:"10px 12px", fontSize:13, border:`1px solid ${T.slate200}`, borderRadius:8, outline:"none", boxSizing:"border-box" }} />
          </div>
          <div style={{ marginBottom:16 }}>
            <label style={{ fontSize:11, fontWeight:600, color:T.slate700, display:"block", marginBottom:5 }}>CONFIRM NEW PASSWORD</label>
            <input type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} autoComplete="new-password"
              style={{ width:"100%", padding:"10px 12px", fontSize:13, border:`1px solid ${T.slate200}`, borderRadius:8, outline:"none", boxSizing:"border-box" }} />
            <div style={{ fontSize:10, color:T.slate400, marginTop:4 }}>Minimum 8 characters.</div>
          </div>
          {error && <div style={{ padding:"8px 12px", background:T.redLt, borderRadius:6, fontSize:11, color:"#991B1B", marginBottom:12 }}>{error}</div>}
          {done  && <div style={{ padding:"8px 12px", background:T.greenLt, borderRadius:6, fontSize:11, color:"#065F46", marginBottom:12 }}>Password updated. Loading your dashboard…</div>}
          <button type="submit" disabled={submitting || done}
            style={{ width:"100%", padding:"11px 14px", fontSize:13, fontWeight:600, color:T.white, background:(submitting||done)?T.slate400:T.navy, border:"none", borderRadius:8, cursor:(submitting||done)?"wait":"pointer", marginBottom:10 }}>
            {done ? "Done" : (submitting ? "Working…" : "Update Password")}
          </button>
          <button type="button" onClick={handleSkip} disabled={submitting||done}
            style={{ width:"100%", padding:"9px 14px", fontSize:11, fontWeight:500, color:T.slate600, background:"transparent", border:`1px solid ${T.slate200}`, borderRadius:8, cursor:(submitting||done)?"wait":"pointer" }}>
            Skip — Keep my current password
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * AuthGuard — top-level wrapper that gates the BCC app behind authentication.
 *
 * Behaviour:
 *   - On mount, checks for an existing Supabase session.
 *   - Subscribes to onAuthStateChange so sign-in / sign-out flips the UI instantly.
 *   - Detects the PASSWORD_RECOVERY event (and a ?reset=true URL marker as a
 *     backstop in case the event fires before this component mounts) and shows
 *     the SetNewPasswordForm before letting the dashboard render.
 *   - While the initial session check is pending, shows a brief loading shell
 *     (no flash of LoginPage for users who are already signed in).
 *   - If supabase is null (env keys missing), renders the children directly so
 *     the app doesn't soft-lock during dev or misconfigured deploys.
 */
export default function AuthGuard({ children }) {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [recovery, setRecovery] = useState(false);

  useEffect(() => {
    if (!supabase) { setChecking(false); return; }
    // If the URL has ?reset=true, treat this as a recovery landing. Belt-and-
    // suspenders with the PASSWORD_RECOVERY auth event below — depending on
    // browser timing, the event can fire before this component subscribes.
    const params = new URLSearchParams(window.location.search);
    if (params.get("reset") === "true") setRecovery(true);

    supabase.auth.getSession().then(({ data }) => {
      setSession(data?.session || null);
      setChecking(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      setSession(sess || null);
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
    });
    return () => { sub?.subscription?.unsubscribe?.(); };
  }, []);

  // Defensive: no supabase client → fall through (matches existing module behaviour).
  if (!supabase) return children;
  // Demo mode bypass — public demo deploys (e.g. bcc-master-template-tau.vercel.app)
  // set VITE_DEMO_MODE=true to render the full app without auth so prospects can
  // explore. Production client installs leave this unset / false.
  if (import.meta.env.VITE_DEMO_MODE === "true") return children;
  if (checking) {
    return (
      <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#1B2B4B", color:"#fff", fontSize:13, letterSpacing:"0.04em" }}>
        Loading Business Command Center…
      </div>
    );
  }
  if (!session) return <LoginPage />;
  if (recovery) return <SetNewPasswordForm onDone={() => setRecovery(false)} />;
  return children;
}
