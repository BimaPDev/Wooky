// Pure desktop-shell logic. No Electron or Node process imports, so it runs under vitest.

/** Window and page background. Keep in step with the dark surface in apps/web tokens. */
export const WINDOW_BACKGROUND = "#0a0a0a";
const WINDOW_TEXT = "#f3f0ff";

const STDERR_TAIL_CHARS = 4_000;
const LINE_BUFFER_CHARS = 8_192;
const LISTENING_LINE = /^WOOKY_LISTENING (\S+)$/;
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(["clipboard-sanitized-write"]);

export class ServerStartError extends Error {
  readonly stderrTail: string;

  constructor(reason: string, stderrTail: string) {
    super(reason);
    this.name = "ServerStartError";
    this.stderrTail = stderrTail;
  }
}

/** Returns the URL when `line` is `WOOKY_LISTENING <http(s) url>`, otherwise undefined. */
export function parseListeningLine(line: string): string | undefined {
  const url = LISTENING_LINE.exec(line.trim())?.[1];
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Finds the listening line in stdout that may arrive split across chunks. */
export class ListeningLineParser {
  #buffer = "";

  feed(chunk: string): string | undefined {
    this.#buffer += chunk;
    for (let newline = this.#buffer.indexOf("\n"); newline !== -1;) {
      const url = parseListeningLine(this.#buffer.slice(0, newline));
      this.#buffer = this.#buffer.slice(newline + 1);
      if (url) return url;
      newline = this.#buffer.indexOf("\n");
    }
    if (this.#buffer.length > LINE_BUFFER_CHARS)
      this.#buffer = this.#buffer.slice(-LINE_BUFFER_CHARS);
    return undefined;
  }
}

/** Keeps the most recent stderr output, for error messages. */
export class OutputTail {
  #text = "";

  add(chunk: string): void {
    this.#text = (this.#text + chunk).slice(-STDERR_TAIL_CHARS);
  }

  text(): string {
    return this.#text.trim();
  }
}

export interface ChildExit {
  code: number | null;
  signal: string | null;
  /** Set when the process could not be started at all. */
  reason?: string;
}

/** The slice of a child process the startup watcher needs. main.ts adapts ChildProcess to it. */
export interface ChildEvents {
  onStdout(listener: (text: string) => void): void;
  onStderr(listener: (text: string) => void): void;
  onExit(listener: (exit: ChildExit) => void): void;
}

/**
 * Resolves with the URL from the first `WOOKY_LISTENING` line. Rejects on the deadline, or if the
 * process exits first. Both rejections carry the stderr tail.
 */
export function awaitListening(child: ChildEvents, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const parser = new ListeningLineParser();
    const tail = new OutputTail();
    let settled = false;
    const fail = (reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ServerStartError(reason, tail.text()));
    };
    const timer = setTimeout(
      () => fail(`The server did not report readiness within ${timeoutMs / 1000} s.`),
      timeoutMs,
    );
    child.onStdout((text) => {
      if (settled) return;
      const url = parser.feed(text);
      if (!url) return;
      settled = true;
      clearTimeout(timer);
      resolve(url);
    });
    child.onStderr((text) => tail.add(text));
    child.onExit((exit) => {
      const how = exit.reason ?? `code ${exit.code}, signal ${exit.signal}`;
      fail(`The server exited before it was ready (${how}).`);
    });
  });
}

export interface ServerLaunchInput {
  /** Electron's own binary, run as Node via ELECTRON_RUN_AS_NODE. */
  execPath: string;
  /** ESM loader that runs the server's TypeScript sources. */
  loaderUrl: string;
  serverEntry: string;
  webDist: string;
  home: string;
  repoRoot: string;
  env: Readonly<Record<string, string | undefined>>;
}

export interface ServerLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** argv and env for the server child. Port 0 lets the server pick a free port and report it. */
export function buildServerLaunch(input: ServerLaunchInput): ServerLaunch {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  env.WOOKY_HOME = input.home;
  return {
    command: input.execPath,
    args: [
      "--import",
      input.loaderUrl,
      input.serverEntry,
      "--port",
      "0",
      "--web-dist",
      input.webDist,
      "--home",
      input.home,
    ],
    cwd: input.repoRoot,
    env,
  };
}

export type NavigationDecision = "allow" | "external" | "block";

/**
 * In-app navigation stays on the server's origin. Other http(s) links open in the system
 * browser. Every other scheme (file:, javascript:, data:, ...) is blocked.
 */
export function decideNavigation(target: string, appOrigin: string): NavigationDecision {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "block";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "block";
  return url.origin === appOrigin ? "allow" : "external";
}

/** Every permission request is denied except the one the app needs. */
export function isPermissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission);
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(body: string): string {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    "<style>",
    `html,body{margin:0;height:100%;background:${WINDOW_BACKGROUND};color:${WINDOW_TEXT};`,
    'font:14px/1.5 -apple-system,BlinkMacSystemFont,"Inter",sans-serif}',
    "main{padding:56px 32px 32px;max-width:760px}",
    "h1{font-size:18px;font-weight:600;margin:0 0 12px}",
    "pre{white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,Menlo,monospace;",
    "opacity:.75;margin:16px 0 0}",
    "</style></head><body><main>",
    body,
    "</main></body></html>",
  ].join("");
}

export function startingPage(): string {
  return page("<p>Starting Wooky…</p>");
}

export function errorPage(title: string, detail: string, stderrTail: string): string {
  const tail = stderrTail ? `<pre>${escapeHtml(stderrTail)}</pre>` : "";
  return page(`<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>${tail}`);
}

/** One dialog at a time. A second call shares the promise already in flight. */
export function createSingleFlight() {
  let pending: Promise<unknown> | null = null;
  return function run<T>(start: () => Promise<T>): Promise<T> {
    if (pending) return pending as Promise<T>;
    const task = start().finally(() => {
      if (pending === task) pending = null;
    });
    pending = task;
    return task;
  };
}

/** The sheet's parent, or null when that window is already gone. */
export function usableWindow<T extends { isDestroyed(): boolean }>(
  win: T | null | undefined,
): T | null {
  if (!win || win.isDestroyed()) return null;
  return win;
}

export function dataPageUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
