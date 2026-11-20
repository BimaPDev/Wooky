import { spawn, spawnSync } from "node:child_process";

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface SelfCommandRunner {
  runSync(file: string, args: readonly string[], options?: CommandOptions): CommandResult;
  runInherit(file: string, args: readonly string[], options?: CommandOptions): Promise<number>;
}

/** Argv-only process runner for `wooky service|update|uninstall`. */
export const defaultSelfCommandRunner: SelfCommandRunner = {
  runSync(file, args, options) {
    const res = spawnSync(file, [...args], {
      encoding: "utf8",
      env: options?.env,
      cwd: options?.cwd,
    });
    return {
      status: res.status,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      ...(res.error ? { error: res.error } : {}),
    };
  },

  runInherit(file, args, options) {
    return new Promise<number>((resolve, reject) => {
      const child = spawn(file, [...args], {
        stdio: "inherit",
        env: options?.env,
        cwd: options?.cwd,
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code !== null) resolve(code);
        else resolve(signal ? 1 : 0);
      });
    });
  },
};
