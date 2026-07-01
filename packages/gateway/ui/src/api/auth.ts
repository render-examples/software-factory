// Auth + operator identity. The API key is the sole gate (same as the gateway).
// The operator name is a self-entered handle sent as `resolvedBy` for the audit
// trail — a display convenience, not an access boundary (per the spec).

const KEY = "render-agents-ui-key";
const OPERATOR = "render-agents-operator";

function fromQuery(name: string): string | null {
  return new URLSearchParams(location.search).get(name);
}

/** Remove a query param from the address bar without a navigation (CR-19). */
function stripQueryParam(name: string): void {
  try {
    const url = new URL(location.href);
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      history.replaceState(null, "", url.toString());
    }
  } catch {
    /* non-browser / malformed URL — ignore */
  }
}

export function getKey(): string {
  const stored = sessionStorage.getItem(KEY);
  if (stored) return stored;
  // A key supplied via `?key=` (e.g. a bookmarked link) is persisted to
  // sessionStorage and immediately stripped from the URL so it doesn't linger in
  // browser history, server logs, or the Referer header (CR-19).
  const fromUrl = fromQuery("key");
  if (fromUrl) {
    const trimmed = fromUrl.trim();
    sessionStorage.setItem(KEY, trimmed);
    stripQueryParam("key");
    return trimmed;
  }
  return "";
}

export function setKey(k: string): void {
  sessionStorage.setItem(KEY, k.trim());
}

export function hasKey(): boolean {
  return getKey().trim().length > 0;
}

export function getOperator(): string {
  return localStorage.getItem(OPERATOR) ?? "";
}

export function setOperator(name: string): void {
  localStorage.setItem(OPERATOR, name.trim());
}
