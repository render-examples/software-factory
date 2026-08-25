import { createHash } from "node:crypto";
import type { CommandRecord, EventLogStore } from "@render-agents/store";
import { buildEventRecord } from "@render-agents/store";
import { admit, type PolicyDocument, type TriggerContext, type WorkTarget } from "@render-agents/policy";

export interface HandlerDeps {
  events: EventLogStore;
  policy: PolicyDocument;
  beforeAppend?: (command: CommandRecord) => Promise<void>;
}

export function decisionKey(commandId: string, role: string): string {
  return `cmd:${createHash("sha256").update(`${commandId}:${role}`).digest("hex").slice(0, 32)}`;
}

export function buildCommandHandler(deps: HandlerDeps) {
  return async function handle(command: CommandRecord): Promise<void> {
    const payload = command.payload as {
      repository?: string;
      label?: string;
      actorHasWriteAccess?: boolean;
      paths?: string[];
      changedFiles?: number;
      changedLines?: number;
    };

    const trigger: TriggerContext = {
      repository: payload.repository ?? "",
      label: payload.label ?? "",
      actorHasWriteAccess: payload.actorHasWriteAccess === true,
    };

    const target: WorkTarget = {
      repository: trigger.repository,
      paths: payload.paths ?? [],
      changedFiles: payload.changedFiles ?? 0,
      changedLines: payload.changedLines ?? 0,
    };

    const decision = admit(deps.policy, trigger, target);

    await deps.beforeAppend?.(command);

    const runId = `run-${createHash("sha256").update(command.id).digest("hex").slice(0, 24)}`;

    await deps.events.append({
      ...buildEventRecord(
        runId,
        {
          type: "run.started",
          trigger: command.kind,
          input: {
            decision: decision.outcome,
            ...(decision.outcome === "decline"
              ? { reason: decision.reason, rule: decision.rule }
              : {}),
            ...(decision.outcome === "needs_approval" ? { gates: decision.gates } : {}),
            repository: trigger.repository,
            label: trigger.label,
            policyVersion: deps.policy.version,
          },
        },
        { agentName: "policy", spanId: runId },
      ),
      idempotencyKey: decisionKey(command.id, "decision"),
      ...(command.correlationId ? { correlationId: command.correlationId } : {}),
      classification: "internal",
    });
  };
}
