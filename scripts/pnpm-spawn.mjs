import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));

function jsExecpath(execpath) {
  return execpath && /\.(?:cjs|mjs|js)$/i.test(execpath) ? execpath : null;
}

/** argv-only prefix to run `pnpm <argv...>` without `shell: true`. */
export function pnpmCommand(argv, env = process.env) {
  const cli = jsExecpath(env.npm_execpath);
  if (cli) return { file: process.execPath, args: [cli, ...argv] };
  if (process.platform !== "win32") return { file: "pnpm", args: argv };
  const cjs = join(repo, "node_modules", "pnpm", "bin", "pnpm.cjs");
  if (existsSync(cjs)) return { file: process.execPath, args: [cjs, ...argv] };
  const pnpmCmd = join(repo, "node_modules", ".bin", "pnpm.cmd");
  if (existsSync(pnpmCmd)) {
    const comspec = env.ComSpec ?? "cmd.exe";
    return { file: comspec, args: ["/d", "/s", "/c", pnpmCmd, ...argv] };
  }
  return { file: "pnpm", args: argv };
}
