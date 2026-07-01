import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Self-hosted JetBrains Mono (variable) — the brutalist CLI theme's single
// typeface; the woff2 is bundled so the UI needs no network for fonts.
import "@fontsource-variable/jetbrains-mono";
import { App } from "./App";
import { canonicalizePath } from "./state/router";
import { applyTheme, getTheme } from "./state/theme";
import "./styles.css";

// Fold stray path-style deep links (e.g. /ui/approvals) back onto the hash base
// before React reads location, so routing is deterministic from first render.
canonicalizePath();
applyTheme(getTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
