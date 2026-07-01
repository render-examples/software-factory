import { type ReactNode, type SelectHTMLAttributes, useId, useState } from "react";
import { pretty } from "../lib/format";

export function StatusBadge({ status }: { status: string }) {
  return <span className={`pill s-${status}`}>{status}</span>;
}

export function Spinner() {
  return <span className="spin" role="status" aria-label="loading" />;
}

export function SectionHeader({
  title, sub, children,
}: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="section-header">
      <div>
        <h2>{title}</h2>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {children && <><span className="spacer" />{children}</>}
    </div>
  );
}

export interface SelectOption { value: string; label: string }

export function Select({
  label, options, className, ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label?: string; options: SelectOption[] }) {
  const id = useId();
  return (
    <span className="row" style={{ gap: "0.35rem" }}>
      {label && <label htmlFor={id} className="faint nowrap">{label}</label>}
      <select id={id} className={className} {...rest}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </span>
  );
}

export function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="banner">{error}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
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
