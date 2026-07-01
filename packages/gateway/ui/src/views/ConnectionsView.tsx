import { client } from "../api/client";
import { useApp } from "../state/app";
import { useAsync } from "../hooks/useAsync";
import { relativeTime } from "../lib/format";
import { ErrorBanner, Empty, Spinner, SectionHeader } from "../components/ui";
import { useToast } from "../components/Toaster";
import type { ConnectionInfo } from "../api/types";

// Per-user OAuth connections. The operator name (top bar) is the user id — each
// provider connection is scoped to that user (multi-tenant), matching the
// gateway's signed-state OAuth flow.
export function ConnectionsView() {
  const toast = useToast();
  const { operator } = useApp();
  const userId = operator.trim();
  const { data, error, loading, reload } = useAsync(
    () => client.listConnections(userId || undefined),
    [userId],
  );
  const providers = data?.providers ?? [];

  function connect(p: ConnectionInfo) {
    if (!userId) { toast.error("Set an operator name (top bar) first — it's used as the user id.", "No user id"); return; }
    // Full-page redirect into the provider's consent screen; the gateway handles
    // the callback and stores the encrypted tokens.
    window.location.href = client.oauthAuthorizeUrl(p.provider, userId);
  }

  async function disconnect(p: ConnectionInfo) {
    if (!userId) return;
    try {
      await client.disconnectOAuth(p.provider, userId);
      toast.info(`Disconnected ${p.provider}`);
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e), "Disconnect failed");
    }
  }

  return (
    <div className="panel">
      <SectionHeader
        title="Connections"
        sub={userId ? <>OAuth connections for <span className="mono">{userId}</span></> : "Set an operator name to manage connections"}
      >
        <button className="ghost" aria-label="Reload" onClick={reload}>{loading ? <Spinner /> : "↻"}</button>
      </SectionHeader>

      {!userId && <div className="banner">Enter an operator name in the top bar; it is used as the OAuth user id.</div>}
      <ErrorBanner error={error} />

      {providers.length === 0 && !loading ? (
        <Empty>No OAuth providers are configured on this gateway.</Empty>
      ) : (
        <table>
          <thead><tr><th>Provider</th><th>Status</th><th>Scopes</th><th>Expires</th><th></th></tr></thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.provider} style={{ cursor: "default" }}>
                <td>{p.provider}</td>
                <td><span className={`pill ${p.connected ? "s-completed" : "s-cancelled"}`}>{p.connected ? "connected" : "not connected"}</span></td>
                <td className="muted mono">{p.scopes?.length ? p.scopes.join(" ") : "—"}</td>
                <td className="muted">{p.expiresAt ? relativeTime(p.expiresAt) : "—"}</td>
                <td>
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    {p.connected
                      ? <button className="ghost danger" onClick={() => disconnect(p)}>disconnect</button>
                      : <button className="primary" onClick={() => connect(p)}>connect</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
