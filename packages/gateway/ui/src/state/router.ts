import { useEffect, useState } from "react";
import { DEFAULT_SECTION } from "./sections";

export interface Route {
  /** Path segments after the leading `#/`, e.g. `["runs", "abc"]`. */
  segments: string[];
  query: URLSearchParams;
  hash: string;
}

/** SPA mount base without a trailing slash (e.g. "/ui"). */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Legacy/alias section ids → canonical section id (sub-segments preserved). */
const ALIASES: Record<string, string> = { threads: DEFAULT_SECTION };

/**
 * Fold any extra pathname under the SPA base into the hash and rewrite back to
 * the base. Hash routing means all view state should live after `#`; landing on
 * a path-style deep link like `/ui/approvals` otherwise sticks as
 * `/ui/approvals#/approvals` and never self-corrects. Run once before render.
 */
export function canonicalizePath(): void {
  const p = location.pathname;
  if (BASE && p.startsWith(BASE) && p !== BASE && p !== `${BASE}/`) {
    const extra = p.slice(BASE.length).replace(/^\//, "");
    const hash = location.hash || (extra ? `#/${extra}` : "");
    history.replaceState(null, "", `${BASE}/${hash}`);
  }
}

function splitRaw(raw: string): { segments: string[]; query: string } {
  const [pathPart, queryPart] = raw.split("?");
  const segments = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
  return { segments, query: queryPart ?? "" };
}

export function parseHash(): Route {
  const raw = location.hash.replace(/^#\/?/, "");
  const { segments, query } = splitRaw(raw);
  // Renders correctly even if the URL still carries the old id (cleaned up on boot via rewriteAlias).
  const mapped = segments.length > 0 && ALIASES[segments[0]]
    ? [ALIASES[segments[0]], ...segments.slice(1)]
    : segments;
  return { segments: mapped, query: new URLSearchParams(query), hash: location.hash };
}

export function navigate(to: string): void {
  const next = to.startsWith("#") ? to : `#/${to.replace(/^\/?/, "")}`;
  if (location.hash === next) return;
  location.hash = next;
}

function rewriteAlias(): boolean {
  const raw = location.hash.replace(/^#\/?/, "");
  const { segments, query } = splitRaw(raw);
  if (segments.length > 0 && ALIASES[segments[0]]) {
    const rest = [ALIASES[segments[0]], ...segments.slice(1)].join("/");
    navigate(query ? `${rest}?${query}` : rest);
    return true;
  }
  return false;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onChange = () => {
      if (rewriteAlias()) return; // the rewrite fires a fresh hashchange
      setRoute(parseHash());
    };
    window.addEventListener("hashchange", onChange);
    if (!location.hash) navigate(DEFAULT_SECTION);
    else rewriteAlias();
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
