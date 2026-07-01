import type { ComponentType, SVGProps } from "react";
import {
  RunsIcon, ApprovalsIcon, ChatIcon, SchedulesIcon,
  WorkflowsIcon, ConnectionsIcon, OpsIcon,
} from "../components/Icons";

// Single source of truth for the operator console's information architecture.
// The nav rail, command palette, breadcrumb, and router default all read from
// here so adding or moving a section is a one-line change. Grouped by operator
// intent: Work (initiate), Monitor (observe/act), Configure.

export type SectionGroup = "work" | "monitor" | "configure";

/** Optional runtime capability a section depends on (hides the nav item when absent). */
export type Capability = "oauth";

export interface NavItem {
  id: string;
  label: string;
  group: SectionGroup;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** When set, the item is only shown if the capability is present. */
  gate?: Capability;
  /** Show the pending-approvals count badge (Approvals only). */
  badge?: "approvals";
}

export const GROUP_ORDER: { id: SectionGroup; label: string }[] = [
  { id: "work", label: "Work" },
  { id: "monitor", label: "Monitor" },
  { id: "configure", label: "Configure" },
];

export const NAV_ITEMS: NavItem[] = [
  { id: "chat", label: "Chat", group: "work", Icon: ChatIcon },
  { id: "workflows", label: "Workflows", group: "work", Icon: WorkflowsIcon },
  { id: "schedules", label: "Schedules", group: "work", Icon: SchedulesIcon },
  { id: "runs", label: "Runs", group: "monitor", Icon: RunsIcon, badge: undefined },
  { id: "approvals", label: "Approvals", group: "monitor", Icon: ApprovalsIcon, badge: "approvals" },
  { id: "connections", label: "Connections", group: "configure", Icon: ConnectionsIcon, gate: "oauth" },
  { id: "ops", label: "Ops", group: "configure", Icon: OpsIcon },
];

/** The section the app lands on with no hash (primary object = conversation). */
export const DEFAULT_SECTION = "chat";

const LABELS: Record<string, string> = Object.fromEntries(NAV_ITEMS.map((n) => [n.id, n.label]));

/** Human label for a section id (used by the breadcrumb); falls back to the id. */
export function sectionLabel(id: string | undefined): string {
  if (!id) return LABELS[DEFAULT_SECTION];
  return LABELS[id] ?? id;
}

/** True when the section id is a known, routable view. */
export function isKnownSection(id: string | undefined): boolean {
  if (!id) return true;
  return id in LABELS;
}
