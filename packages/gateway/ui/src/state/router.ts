import { useEffect, useState } from "react";

export interface Route {
  /** Path segments after the leading `#/`, e.g. `["runs", "abc"]`. */
  segments: string[];
  query: URLSearchParams;
  hash: string;
}

export function parseHash(): Route {
  const raw = location.hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const segments = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
  return {
    segments,
    query: new URLSearchParams(queryPart ?? ""),
    hash: location.hash,
  };
}

export function navigate(to: string): void {
  const next = to.startsWith("#") ? to : `#/${to.replace(/^\/?/, "")}`;
  if (location.hash === next) return;
  location.hash = next;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    if (!location.hash) navigate("runs");
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
