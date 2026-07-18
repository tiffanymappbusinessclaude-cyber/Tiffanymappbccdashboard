import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase.js";

// ── Design Tokens (match BCC) ──
const T = {
  navy:    "#1B2B4B",
  blue:    "#2D7DD2",
  blueLt:  "#EFF6FF",
  white:   "#FFFFFF",
  slate50: "#F8FAFC",
  slate100:"#F1F5F9",
  slate200:"#E2E8F0",
  slate400:"#94A3B8",
  slate600:"#475569",
  slate700:"#334155",
  slate800:"#1E293B",
  slate900:"#0F172A",
  red:     "#EF4444",
  redLt:   "#FEE2E2",
  green:   "#10B981",
  greenLt: "#D1FAE5",
};

/**
 * LoginPage — handles sign-in, first-time signup, and invite-link signup.
 *
 * Flow paths:
 *   1. Existing user → "Sign In" tab, email + password
 *   2. First-time setup → "Sign Up" tab, email + password; on success the
 *      Supabase trigger (migration 023) links the new auth.user_id to the
 *      already-seeded team_membership row matching that email.
 *   3. Invited user → URL contains ?invite=<token>; the form pre-fills email
 *      from team_invites lookup and shows "Accept invite" tab. Same trigger
 *      logic links the new user to the invited team_membership row.
 */
export default function LoginPage() {
  const [mode, setMode] = useState("signin"); // signin | signup | invite
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [inviteToken, setInviteToken] = useState(null);
  const [invitedRole, setInvitedRole] = useState(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [info, setInfo] = useState("");

  // Detect invite token in URL on mount; look up the invite + auto-switch to invite mode
  useEffect(() => {
    if (!supabase) return;
    const params = new URLSearchParams(window.location.search);
    const token = params.get("invite");
    if (!token) return;
    setInviteToken(token);
    setMode("invite");
    supabase.from("team_invites")
      .select("email,full_name,role,expires_at,accepted_at,cancelled_at")
      .eq("invite_token", token).maybeSingle()
      .then(({ data, error }) => {
        if (error || !data) { setError("Invite link not recognized."); return; }
        if (data.cancelled_at) { setError("This invite has been cancelled."); return; }
        if (data.accepted_at) { setError("This invite has already been accepted. Use Sign In."); return; }
        if (new Date(data.expires_at) < new Date()) { setError("This invite has expired."); return; }
        setEmail(data.email);
        setFullName(data.full_name || "");
        setInvitedRole(data.role);
      });
  }, []);

  const handleSubmit = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    setError(""); setInfo("");
    if (!supabase) { setError("Auth not configured — VITE_SUPABASE keys missing."); return; }
    if (!email) { setError("Email required."); return; }
    if (mode !== "forgot" && !password) { setError("Password required."); return; }
    if ((mode === "signup" || mode === "invite") && password !== confirmPassword) {
      setError("Passwords do not match."); return;
    }
    if ((mode === "signup" || mode === "invite") && password.length < 8) {
      setError("Password must be at least 8 characters."); return;
    }
    setSubmitting(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        // AuthGuard will detect the session change and render the app.
      } else if (mode === "forgot") {
        // Password reset / fresh confirmation link. The redirectTo URL is what
        // tests whether the Supabase Auth Site URL config is correct — if it
        // is, this link in the user's inbox lands on the live BCC instead of
        // localhost. The ?reset=true marker lets the app know to show a
        // "set a new password" prompt after they return (future enhancement).
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + "/?reset=true",
        });
        if (error) throw error;
        setInfo("Check your email — a sign-in link has been sent to " + email + ". The link is valid for 1 hour.");
      } else {
        // signup OR invite — same flow: create auth.users row.
        // Migration 023 trigger links the new user_id to the existing
        // team_membership / team_invite row by matching email.
        const { error } = await supabase.auth.signUp({
          email, password,
          options: { data: { full_name: fullName, invite_token: inviteToken || null } },
        });
        if (error) throw error;
        if (mode === "invite" && inviteToken) {
          // Mark the invite accepted explicitly (the trigger does this too, but
          // we belt-and-suspender it here for client-side feedback).
          await supabase.from("team_invites").update({ accepted_at: new Date().toISOString() }).eq("invite_token", inviteToken);
        }
        setInfo("Account created. You can now sign in below.");
        setMode("signin");
        setPassword(""); setConfirmPassword("");
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const isInvite = mode === "invite";
  const isSignup = mode === "signup" || isInvite;

  return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:`linear-gradient(135deg, ${T.navy} 0%, #2D3F66 100%)`, padding:20 }}>
      <div style={{ width:"100%", maxWidth:420, background:T.white, borderRadius:16, boxShadow:"0 20px 50px rgba(0,0,0,0.25)", padding:36 }}>
        {/* Logo + header */}
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
          <div style={{ width:36, height:36, borderRadius:8, background:T.navy, display:"flex", alignItems:"center", justifyContent:"center", color:T.white, fontWeight:700, fontSize:18 }}>⚡</div>
          <div>
            <div style={{ fontSize:14, fontWeight:700, color:T.slate900 }}>Sunshine State Insurance - State Farm Agency</div>
            <div style={{ fontSize:11, color:T.slate600 }}>Business Command Center</div>
          </div>
        </div>
        <div style={{ height:1, background:T.slate100, margin:"20px 0" }} />

        {/* Tabs */}
        {!isInvite && (
          <div style={{ display:"flex", gap:4, padding:4, background:T.slate100, borderRadius:8, marginBottom:20 }}>
            {[{id:"signin",label:"Sign In"},{id:"signup",label:"First Time? Sign Up"}].map(t => (
              <button key={t.id} onClick={()=>{setMode(t.id); setError(""); setInfo("");}}
                style={{ flex:1, padding:"8px 12px", fontSize:12, fontWeight:600, color:mode===t.id?T.white:T.slate600, background:mode===t.id?T.navy:"transparent", border:"none", borderRadius:6, cursor:"pointer" }}>
                {t.label}
              </button>
            ))}
          </div>
        )}

        {isInvite && (
          <div style={{ background:T.blueLt, border:`1px solid ${T.blue}40`, borderLeft:`4px solid ${T.blue}`, borderRadius:8, padding:"10px 12px", marginBottom:16 }}>
            <div style={{ fontSize:11, fontWeight:600, color:T.navy, marginBottom:2 }}>Team Invitation</div>
            <div style={{ fontSize:11, color:T.slate700 }}>
              You've been invited as <b>{invitedRole || "team member"}</b>. Set your password to accept.
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {isSignup && (
            <div style={{ marginBottom:12 }}>
              <label style={{ fontSize:11, fontWeight:600, color:T.slate700, display:"block", marginBottom:5 }}>FULL NAME</label>
              <input type="text" value={fullName} onChange={e=>setFullName(e.target.value)}
                style={{ width:"100%", padding:"10px 12px", fontSize:13, border:`1px solid ${T.slate200}`, borderRadius:8, outline:"none", boxSizing:"border-box" }} />
            </div>
          )}
          <div style={{ marginBottom:12 }}>
            <label style={{ fontSize:11, fontWeight:600, color:T.slate700, display:"block", marginBottom:5 }}>EMAIL</label>
            <input type="email" value={email} onChange={e=>setEmail(e.target.value)} disabled={isInvite}
              autoComplete="email" required
              style={{ width:"100%", padding:"10px 12px", fontSize:13, border:`1px solid ${T.slate200}`, borderRadius:8, outline:"none", background:isInvite?T.slate50:T.white, color:T.slate900, boxSizing:"border-box" }} />
          </div>
          {mode !== "forgot" && (
            <div style={{ marginBottom: mode === "signin" ? 6 : (isSignup ? 12 : 20) }}>
              <label style={{ fontSize:11, fontWeight:600, color:T.slate700, display:"block", marginBottom:5 }}>PASSWORD</label>
              <input type="password" value={password} onChange={e=>setPassword(e.target.value)}
                autoComplete={mode==="signin"?"current-password":"new-password"} required
                style={{ width:"100%", padding:"10px 12px", fontSize:13, border:`1px solid ${T.slate200}`, borderRadius:8, outline:"none", boxSizing:"border-box" }} />
            </div>
          )}
          {mode === "signin" && (
            <div style={{ textAlign:"right", marginBottom:16 }}>
              <button type="button" onClick={() => { setMode("forgot"); setError(""); setInfo(""); setPassword(""); }}
                style={{ background:"none", border:"none", color:T.blue, fontSize:11, cursor:"pointer", padding:0, textDecoration:"underline" }}>
                Forgot password? Send me a sign-in link
              </button>
            </div>
          )}
          {mode === "forgot" && (
            <div style={{ marginBottom:16, padding:"10px 12px", background:T.blueLt, border:`1px solid ${T.blue}40`, borderRadius:8, fontSize:11, color:T.slate700 }}>
              We will email you a sign-in link. Use this to verify the redirect lands on the BCC and not localhost.
            </div>
          )}
          {isSignup && (
            <div style={{ marginBottom:20 }}>
              <label style={{ fontSize:11, fontWeight:600, color:T.slate700, display:"block", marginBottom:5 }}>CONFIRM PASSWORD</label>
              <input type="password" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} required
                style={{ width:"100%", padding:"10px 12px", fontSize:13, border:`1px solid ${T.slate200}`, borderRadius:8, outline:"none", boxSizing:"border-box" }} />
              <div style={{ fontSize:10, color:T.slate400, marginTop:4 }}>Minimum 8 characters.</div>
            </div>
          )}
          {error && <div style={{ padding:"8px 12px", background:T.redLt, borderRadius:6, fontSize:11, color:"#991B1B", marginBottom:12 }}>{error}</div>}
          {info  && <div style={{ padding:"8px 12px", background:T.greenLt, borderRadius:6, fontSize:11, color:"#065F46", marginBottom:12 }}>{info}</div>}
          <button type="submit" disabled={submitting}
            style={{ width:"100%", padding:"11px 14px", fontSize:13, fontWeight:600, color:T.white, background:submitting?T.slate400:T.navy, border:"none", borderRadius:8, cursor:submitting?"wait":"pointer" }}>
            {submitting ? "Working…" : (
              mode==="signin" ? "Sign In" :
              mode==="forgot" ? "Send sign-in link" :
              isInvite ? "Accept Invite & Create Account" : "Create Account"
            )}
          </button>
          {mode === "forgot" && (
            <div style={{ textAlign:"center", marginTop:14 }}>
              <button type="button" onClick={() => { setMode("signin"); setError(""); setInfo(""); }}
                style={{ background:"none", border:"none", color:T.slate600, fontSize:11, cursor:"pointer", padding:0, textDecoration:"underline" }}>
                ← Back to sign in
              </button>
            </div>
          )}
        </form>

        <div style={{ marginTop:18, fontSize:10, color:T.slate400, textAlign:"center" }}>
          Built by Imaginary Farms LLC · imaginary-farms.com
        </div>
      </div>
    </div>
  );
}
