// Auth + operator identity for the UI.
//
// The API key is exchanged once at `/ui/login` for a signed, httpOnly session
// cookie — so the raw key never lives in JS (XSS-safe) or in a URL. Every request
// and EventSource rides that same-origin cookie automatically; there is no bearer
// token stored client-side. The operator name is a self-entered handle sent as
// `resolvedBy` for the audit trail — a display convenience, not an access boundary.

const OPERATOR = "render-agents-operator";

export interface Whoami {
  userId: string;
  role: string;
}

/** Exchange a `?key=` bootstrap (e.g. a bookmarked link) for a session, then
 *  strip it from the URL so it doesn't linger in history/logs (CR-19). */
export async function bootstrapFromQuery(): Promise<void> {
  const key = new URLSearchParams(location.search).get("key");
  if (!key) return;
  await login(key.trim());
  stripQueryParam("key");
}

/** POST the key to `/ui/login`; on success the server sets the session cookie. */
export async function login(key: string): Promise<boolean> {
  try {
    const res = await fetch("/ui/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
      credentials: "same-origin",
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function logout(): Promise<void> {
  await fetch("/ui/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
}

/** Resolve the current session (cookie is httpOnly, so JS can't read it directly). */
export async function whoami(): Promise<Whoami | null> {
  try {
    const res = await fetch("/whoami", { credentials: "same-origin" });
    return res.ok ? ((await res.json()) as Whoami) : null;
  } catch {
    return null;
  }
}

export function getOperator(): string {
  return localStorage.getItem(OPERATOR) ?? "";
}

export function setOperator(name: string): void {
  localStorage.setItem(OPERATOR, name.trim());
}

function stripQueryParam(name: string): void {
  try {
    const url = new URL(location.href);
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      history.replaceState(null, "", url.toString());
    }
  } catch {
    /* ignore */
  }
}
