import { useStore, type Theme } from "./store.ts";

const KEY = "age.theme";

export function loadTheme(): Theme | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === "dark" || value === "light" ? value : null;
  } catch {
    return null;
  }
}

export function syncRootThemeClass(theme: Theme | null, effective: Theme = effectiveTheme(theme)) {
  if (typeof document === "undefined") return;
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  document.documentElement.classList.toggle("dark", effective === "dark");
}

export function setTheme(theme: Theme) {
  useStore.setState({ theme });
  syncRootThemeClass(theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage can be unavailable (private windows); the choice still holds for this session.
  }
}

export function effectiveTheme(theme: Theme | null): Theme {
  if (theme) return theme;
  const light =
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
  return light ? "light" : "dark";
}

export function toggleTheme() {
  setTheme(effectiveTheme(useStore.getState().theme) === "dark" ? "light" : "dark");
}
