import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from "react";

export type ToastKind = "success" | "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  title?: string;
  message: string;
}

export interface ToastInput {
  kind?: ToastKind;
  title?: string;
  message: string;
  /** Auto-dismiss delay in ms; 0 keeps it until dismissed. Default 4000. */
  duration?: number;
}

interface ToastApi {
  push: (t: ToastInput) => number;
  dismiss: (id: number) => void;
  success: (message: string, title?: string) => number;
  error: (message: string, title?: string) => number;
  info: (message: string, title?: string) => number;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) { clearTimeout(timer); timers.current.delete(id); }
  }, []);

  const push = useCallback((input: ToastInput) => {
    const id = nextId.current++;
    const toast: Toast = { id, kind: input.kind ?? "info", title: input.title, message: input.message };
    setToasts((list) => [...list, toast]);
    const duration = input.duration ?? 4000;
    if (duration > 0) {
      timers.current.set(id, setTimeout(() => dismiss(id), duration));
    }
    return id;
  }, [dismiss]);

  useEffect(() => {
    const map = timers.current;
    return () => { for (const t of map.values()) clearTimeout(t); };
  }, []);

  const api: ToastApi = {
    push,
    dismiss,
    success: (message, title) => push({ kind: "success", message, title }),
    error: (message, title) => push({ kind: "error", message, title, duration: 6000 }),
    info: (message, title) => push({ kind: "info", message, title }),
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toaster" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} role="status">
            <div className="toast-body">
              {t.title && <div className="toast-title">{t.title}</div>}
              <div className="toast-msg">{t.message}</div>
            </div>
            <button className="ghost iconbtn toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>✕</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
