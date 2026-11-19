const TERMINAL_OPEN_KEY = "wooky.terminalOpen";
const LEGACY_TERMINAL_OPEN_KEY = "age.terminalOpen";

export function isElectronShell(): boolean {
  return typeof navigator !== "undefined" && /\belectron\b/i.test(navigator.userAgent);
}

export function isMacDesktopShell(): boolean {
  return isElectronShell() && window.wooky?.platform === "darwin";
}

export function loadTerminalOpen(): boolean {
  try {
    const value =
      localStorage.getItem(TERMINAL_OPEN_KEY) ?? localStorage.getItem(LEGACY_TERMINAL_OPEN_KEY);
    if (value === "1") return true;
    if (value === "0") return false;
  } catch {
    /* ignore */
  }
  return false;
}

export function saveTerminalOpen(open: boolean): void {
  try {
    localStorage.setItem(TERMINAL_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* ignore */
  }
}
