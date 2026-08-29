// Auth + operator identity for the UI.
//
// The API key is exchanged once at `/ui/login` for a signed, httpOnly session
// cookie — so the raw key never lives in JS (XSS-safe) or in a URL. Every request
// and EventSource rides that same-origin cookie automatically; there is no bearer
// token stored client-side. The operator name is a local UI preference only.

const OPERATOR = "render-factory-operator";

export interface Whoami {
  userId: string;
  role: string;
}

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
