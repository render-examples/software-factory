import { useEffect, useState, type ReactNode } from "react";
import { getOperator, login, setOperator, whoami } from "../api/auth";

/**
 * First-load gate. Exchanges the API key for a signed, httpOnly session cookie
 * via `/ui/login` (the raw key never lives in JS or a URL), then renders the app.
 * On boot it resolves the current session with `/whoami`, so a returning operator
 * with a valid cookie skips the form.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "in" | "out">("checking");
  const [key, setKeyInput] = useState("");
  const [name, setName] = useState(getOperator());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const who = await whoami();
      if (live) setState(who ? "in" : "out");
    })();
    return () => { live = false; };
  }, []);

  async function submit() {
    if (!key.trim() || busy) return;
    setBusy(true);
    setErr(null);
    const ok = await login(key.trim());
    setBusy(false);
    if (!ok) { setErr("Invalid API key."); return; }
    if (name.trim()) setOperator(name);
    setState("in");
  }

  if (state === "checking") {
    return (
      <div className="gate">
        <div className="box card"><p className="muted">Checking session…</p></div>
      </div>
    );
  }
  if (state === "in") return <>{children}</>;

  return (
    <div className="gate">
      <div className="box card">
        <h3 style={{ marginTop: 0 }}>render-agents · operator</h3>
        <p className="muted">
          Enter the gateway API key to sign in. It is exchanged for a secure
          session cookie and never stored in the browser.
        </p>
        <label>API key</label>
        <input
          type="password"
          autoFocus
          value={key}
          placeholder="RENDER_AGENTS_API_KEY"
          onChange={(e) => setKeyInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
        <label>Your name (optional)</label>
        <input
          value={name}
          placeholder="for the approval audit trail"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
        {err && <div className="banner err-text" style={{ marginTop: "0.6rem" }}>{err}</div>}
        <div style={{ marginTop: "0.9rem" }}>
          <button className="primary" disabled={!key.trim() || busy} onClick={submit}>
            {busy ? "Signing in…" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
