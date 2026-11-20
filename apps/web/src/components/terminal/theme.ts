import type { ITheme } from "@xterm/xterm";

function cssVar(from: HTMLElement, name: string): string | undefined {
  const value = getComputedStyle(from).getPropertyValue(name).trim();
  return value || undefined;
}

/** xterm.js colours taken from the live CSS tokens. No literals. */
export function readXtermTheme(from: HTMLElement): ITheme {
  return {
    background: cssVar(from, "--bg-0"),
    foreground: cssVar(from, "--text"),
    cursor: cssVar(from, "--text"),
    cursorAccent: cssVar(from, "--bg-0"),
    selectionBackground: cssVar(from, "--bg-active"),
    selectionForeground: cssVar(from, "--text"),
    selectionInactiveBackground: cssVar(from, "--bg-hover"),
    black: cssVar(from, "--bg-3"),
    red: cssVar(from, "--red"),
    green: cssVar(from, "--green"),
    yellow: cssVar(from, "--amber"),
    blue: cssVar(from, "--provider-codex"),
    magenta: cssVar(from, "--accent"),
    cyan: cssVar(from, "--provider-antigravity"),
    white: cssVar(from, "--text-2"),
    brightBlack: cssVar(from, "--text-4"),
    brightRed: cssVar(from, "--red"),
    brightGreen: cssVar(from, "--green"),
    brightYellow: cssVar(from, "--amber"),
    brightBlue: cssVar(from, "--provider-codex"),
    brightMagenta: cssVar(from, "--accent"),
    brightCyan: cssVar(from, "--provider-antigravity"),
    brightWhite: cssVar(from, "--text"),
  };
}

export function readMonoFont(from: HTMLElement): string {
  return getComputedStyle(from).getPropertyValue("--font-mono").trim();
}

export function readMonoSize(from: HTMLElement): number {
  const parsed = Number.parseFloat(getComputedStyle(from).getPropertyValue("--text-sm").trim());
  return Number.isFinite(parsed) ? parsed : 12;
}

export function applyXtermTheme(
  term: { options: { theme?: ITheme; fontFamily?: string; fontSize?: number } },
  from: HTMLElement,
) {
  term.options.theme = readXtermTheme(from);
  const font = readMonoFont(from);
  if (font) term.options.fontFamily = font;
  term.options.fontSize = readMonoSize(from);
}
