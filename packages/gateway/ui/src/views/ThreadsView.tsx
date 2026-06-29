import { useState } from "react";
import { client } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { navigate } from "../state/router";
import { relativeTime } from "../lib/format";
import { ErrorBanner, Empty, Spinner, StatusBadge } from "../components/ui";

export function ThreadsView() {
  const [userId, setUserId] = useState("");
  const [creating, setCreating] = useState(false);
  const { data, error, loading, reload } = useAsync(() => client.listThreads(userId || undefined), [userId]);

  async function newThread() {
    setCreating(true);
    try {
      const t = await client.createThread({ title: "New conversation" });
      navigate(`chat/${t.id}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="panel">
      <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
        <input placeholder="filter by user id" value={userId} onChange={(e) => setUserId(e.target.value)} />
        <button className="ghost" onClick={reload}>{loading ? <Spinner /> : "↻"}</button>
        <span className="spacer" />
        <button className="primary" disabled={creating} onClick={newThread}>+ New conversation</button>
      </div>

      <ErrorBanner error={error} />

      {(data?.threads.length ?? 0) === 0 && !loading ? (
        <Empty>No threads yet. Start one from Chat.</Empty>
      ) : (
        <table>
          <thead><tr><th>Title</th><th>User</th><th>Status</th><th>Last active</th></tr></thead>
          <tbody>
            {data?.threads.map((t) => (
              <tr key={t.id} onClick={() => navigate(`chat/${t.id}`)}>
                <td>{t.title || <span className="faint mono">{t.id.slice(0, 12)}…</span>}</td>
                <td className="muted">{t.userId ?? "—"}</td>
                <td><StatusBadge status={t.status} /></td>
                <td className="muted">{relativeTime(t.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
