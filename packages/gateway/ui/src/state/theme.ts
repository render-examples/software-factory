// Theme selection. Three states: "system" (follow OS via prefers-color-scheme,
// the default), "light", or "dark". The choice is persisted and applied by
// toggling `data-theme` on <html> — styles.css keys light/dark tokens off it.

const KEY = "render-agents-theme";

export type ThemeChoice = "system" | "light" | "dark";

export function getTheme(): ThemeChoice {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = choice;
}

export function setTheme(choice: ThemeChoice): void {
  if (choice === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, choice);
  applyTheme(choice);
}

/** Cycle system → dark → light → system, for a single toggle control. */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  return choice === "system" ? "dark" : choice === "dark" ? "light" : "system";
}
