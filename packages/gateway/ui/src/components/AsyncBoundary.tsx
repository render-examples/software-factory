import { type ReactNode } from "react";
import { ErrorBanner, Empty, Spinner } from "./ui";

interface AsyncBoundaryProps<T> {
  loading: boolean;
  error: string | null;
  data: T | null | undefined;
  /** When provided, decides whether `data` counts as empty. */
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}

/**
 * Standardises the loading → error → empty → content sequence that every view
 * hand-rolled. Keeps the last-known content visible during a background reload
 * (only shows the spinner on the first load) to avoid flicker.
 */
export function AsyncBoundary<T>({
  loading, error, data, isEmpty, empty, children,
}: AsyncBoundaryProps<T>) {
  if (data == null) {
    if (loading) {
      return <div className="async-state"><Spinner /> <span>Loading…</span></div>;
    }
    if (error) return <div className="panel"><ErrorBanner error={error} /></div>;
    return <>{empty ?? <Empty>Nothing here yet.</Empty>}</>;
  }

  const emptied = isEmpty ? isEmpty(data) : false;
  return (
    <>
      {error && <div className="panel" style={{ paddingBottom: 0 }}><ErrorBanner error={error} /></div>}
      {emptied ? (empty ?? <Empty>Nothing here yet.</Empty>) : children(data)}
    </>
  );
}
