import { type SVGProps } from "react";

// Minimal inline icon set (stroke-based, currentColor) so the shell no longer
// leans on emoji glyphs that render inconsistently across platforms.
type IconProps = SVGProps<SVGSVGElement>;

const base = (props: IconProps) => ({
  width: 16, height: 16, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const, "aria-hidden": true, ...props,
});

export function RunsIcon(p: IconProps) {
  return (<svg {...base(p)}><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>);
}

export function ApprovalsIcon(p: IconProps) {
  return (<svg {...base(p)}><path d="M4 21V5a2 2 0 0 1 2-2h9l-1 4h5l-2 6H6" /></svg>);
}

export function ChatIcon(p: IconProps) {
  return (<svg {...base(p)}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>);
}

export function ThreadsIcon(p: IconProps) {
  return (<svg {...base(p)}><rect x="3" y="4" width="18" height="5" rx="1.5" /><rect x="3" y="12" width="18" height="8" rx="1.5" /></svg>);
}

export function SchedulesIcon(p: IconProps) {
  return (<svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>);
}

export function WorkflowsIcon(p: IconProps) {
  return (<svg {...base(p)}><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="15" y="15" width="6" height="6" rx="1" /><path d="M9 6h6a2 2 0 0 1 2 2v7" /></svg>);
}

export function ConnectionsIcon(p: IconProps) {
  return (<svg {...base(p)}><path d="M9 7L5.5 10.5a4 4 0 0 0 5.66 5.66l1.34-1.34" /><path d="M15 17l3.5-3.5a4 4 0 0 0-5.66-5.66l-1.34 1.34" /><line x1="9" y1="15" x2="15" y2="9" /></svg>);
}

export function OpsIcon(p: IconProps) {
  return (<svg {...base(p)}><path d="M3 12h4l2 6 4-14 2 8h6" /></svg>);
}

export function MenuIcon(p: IconProps) {
  return (<svg {...base(p)}><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>);
}

export function SunIcon(p: IconProps) {
  return (<svg {...base(p)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>);
}

export function MoonIcon(p: IconProps) {
  return (<svg {...base(p)}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>);
}

export function MonitorIcon(p: IconProps) {
  return (<svg {...base(p)}><rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>);
}
