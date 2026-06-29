// Auth + operator identity. The API key is the sole gate (same as the gateway).
// The operator name is a self-entered handle sent as `resolvedBy` for the audit
// trail — a display convenience, not an access boundary (per the spec).

const KEY = "render-agents-ui-key";
const OPERATOR = "render-agents-operator";

function fromQuery(name: string): string | null {
  return new URLSearchParams(location.search).get(name);
}

export function getKey(): string {
  return sessionStorage.getItem(KEY) ?? fromQuery("key") ?? "";
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
