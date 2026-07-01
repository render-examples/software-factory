import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Self-hosted JetBrains Mono (variable) — the brutalist CLI theme's single
// typeface; the woff2 is bundled so the UI needs no network for fonts.
import "@fontsource-variable/jetbrains-mono";
import { App } from "./App";
import { applyTheme, getTheme } from "./state/theme";
import "./styles.css";

applyTheme(getTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
