import { client } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { relativeTime } from "../lib/format";
import { ErrorBanner, Empty, Spinner, SectionHeader } from "../components/ui";
import { useToast } from "../components/Toaster";
import type { ConnectionInfo } from "../api/types";

// OAuth connections for the signed-in user. Identity comes from the session
// (server-derived), so connections are always scoped to the authenticated
// caller — never a client-supplied user id (CR-D1).
export function ConnectionsView() {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => client.listConnections(), []);
  const providers = data?.providers ?? [];

  function connect(p: ConnectionInfo) {
    // Full-page redirect into the provider's consent screen; the gateway handles
    // the callback (userId recovered from the signed state) and stores the tokens.
    window.location.href = client.oauthAuthorizeUrl(p.provider);
  }

  async function disconnect(p: ConnectionInfo) {
    try {
      await client.disconnectOAuth(p.provider);
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
        sub="OAuth connections for your account"
      >
        <button className="ghost" aria-label="Reload" onClick={reload}>{loading ? <Spinner /> : "↻"}</button>
      </SectionHeader>

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
