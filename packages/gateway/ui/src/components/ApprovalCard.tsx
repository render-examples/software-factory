import { useState } from "react";
import { client } from "../api/client";
import { useApp } from "../state/app";
import { navigate } from "../state/router";
import { relativeTime, truncate, pretty } from "../lib/format";
import { Json } from "./ui";
import { useToast } from "./Toaster";
import type { Approval } from "../api/types";

/** Approve / deny / comment card. The comment is the resolve `reason`, persisted
 *  on the approval.resolved event (per spec — no standalone annotation). */
export function ApprovalCard({
  approval, onResolved, showRunLink = true,
}: {
  approval: Approval;
  onResolved?: () => void;
  showRunLink?: boolean;
}) {
  const { operator } = useApp();
  const toast = useToast();
  const [comment, setComment] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function resolve(approved: boolean) {
    setBusy(approved ? "approve" : "deny");
    setErr(null);
    try {
      await client.resolveApproval(approval.id, {
        approved,
        resolvedBy: operator || undefined,
        reason: comment.trim() || undefined,
      });
      toast.success(`${approval.toolName} ${approved ? "approved" : "denied"}`);
      onResolved?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setErr(message);
      toast.error(message, "Resolve failed");
      setBusy(null);
    }
  }

  return (
    <div className="card appr-card">
      <div className="row wrap">
        <b className="mono">{approval.toolName}</b>
        <span className="chip">{approval.agentName}</span>
        <span className="spacer" />
        <span className="faint">{relativeTime(approval.requestedAt)}</span>
        {showRunLink && (
          <a href={`#/runs/${approval.runId}`} onClick={(e) => { e.preventDefault(); navigate(`runs/${approval.runId}`); }}>
            run {approval.runId.slice(0, 8)}
          </a>
        )}
      </div>

      <div className="row" style={{ marginTop: 6 }}>
        <span className="muted mono grow">{truncate(pretty(approval.input), 120)}</span>
        <button className="ghost" onClick={() => setExpanded(!expanded)}>{expanded ? "hide" : "input"}</button>
      </div>
      {expanded && <Json value={approval.input} />}

      <div className="appr-actions">
        <input
          className="grow"
          placeholder="comment (optional) — recorded with the decision"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <button className="primary" disabled={!!busy} onClick={() => resolve(true)}>{busy === "approve" ? "…" : "Approve"}</button>
        <button className="danger" disabled={!!busy} onClick={() => resolve(false)}>{busy === "deny" ? "…" : "Deny"}</button>
      </div>
      {err && <div className="banner">{err}</div>}
    </div>
  );
}
