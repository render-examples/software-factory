import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/client";

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Run an async loader on mount and whenever `deps` change; expose reload(). */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const loader = useCallback(fn, deps);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    loader()
      .then((d) => { if (live) setData(d); })
      .catch((e) => {
        if (!live) return;
        setError(e instanceof ApiError ? `${e.message} (${e.status})` : String(e?.message ?? e));
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [loader, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}
