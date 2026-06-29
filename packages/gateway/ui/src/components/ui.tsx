import { useState, type ReactNode } from "react";
import { relativeTime, pretty } from "../lib/format";

export function StatusBadge({ status }: { status: string }) {
  return <span className={`pill s-${status}`}>{status}</span>;
}

export function KindBadge({ kind }: { kind: string }) {
  return <span className="pill kind">{kind}</span>;
}

export function Spinner() {
  return <span className="spin" aria-label="loading" />;
}

export function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="banner">{error}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function RelTime({ iso }: { iso?: string }) {
  return <span title={iso ?? ""}>{relativeTime(iso)}</span>;
}

export function Json({ value, className }: { value: unknown; className?: string }) {
  const text = pretty(value);
  return <pre className={`json ${className ?? ""}`}>{text || <span className="faint">(empty)</span>}</pre>;
}

export function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="ghost"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? "copied" : label}
    </button>
  );
}
