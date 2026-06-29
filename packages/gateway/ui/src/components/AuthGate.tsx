import { useState, type ReactNode } from "react";
import { getKey, getOperator, hasKey, setKey, setOperator } from "../api/auth";

/** First-load gate: capture the API key (sole auth) + operator handle. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(hasKey());
  const [key, setKeyInput] = useState(getKey());
  const [name, setName] = useState(getOperator());

  if (ready) return <>{children}</>;

  return (
    <div className="gate">
      <div className="box card">
        <h3 style={{ marginTop: 0 }}>render-agents · operator</h3>
        <p className="muted">Enter the gateway API key to continue. It is stored only in this tab.</p>
        <label>API key</label>
        <input
          type="password"
          autoFocus
          value={key}
          placeholder="RENDER_AGENTS_API_KEY"
          onChange={(e) => setKeyInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && key.trim()) submit(); }}
        />
        <label>Your name (optional)</label>
        <input
          value={name}
          placeholder="for the approval audit trail"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && key.trim()) submit(); }}
        />
        <div style={{ marginTop: "0.9rem" }}>
          <button className="primary" disabled={!key.trim()} onClick={submit}>Continue</button>
        </div>
      </div>
    </div>
  );

  function submit() {
    setKey(key);
    if (name.trim()) setOperator(name);
    setReady(true);
  }
}
