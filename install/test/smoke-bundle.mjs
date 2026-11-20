#!/usr/bin/env node
// End-to-end smoke test for the release bundle: unpacks into a temp dir,
// runs `node server/wooky.mjs --port 0 --home <tmp>`, verifies `/` returns HTML, and stops it.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const STARTUP_TIMEOUT_MS = 15_000;

async function main() {
  const explicitTarball = process.argv[2] ? resolve(process.argv[2]) : null;
  const workDir = mkdtempSync(join(tmpdir(), "wooky-bundle-smoke-"));
  const appDir = join(workDir, "app");
  const homeDir = join(workDir, "home");

  try {
    let tarballPath = explicitTarball;
    if (!tarballPath) {
      const outDir = join(workDir, "dist-release");
      console.info("Building release bundle into temp dir...");
      const build = spawnSync(
        process.execPath,
        [join(root, "scripts", "release.mjs"), "--version", "0.0.0-smoke", "--out", outDir],
        { cwd: root, stdio: "inherit", env: process.env },
      );
      if (build.status !== 0) {
        throw new Error(`release.mjs failed with status ${build.status ?? 1}`);
      }
      tarballPath = join(outDir, "wooky-0.0.0-smoke.tgz");
    }

    const mkdirRes = spawnSync("mkdir", ["-p", appDir, homeDir]);
    if (mkdirRes.status !== 0) throw new Error("Failed to create temp directories.");

    const extract = spawnSync("tar", ["-xzf", tarballPath, "-C", appDir], { stdio: "inherit" });
    if (extract.status !== 0) {
      throw new Error(`tar extract failed with status ${extract.status ?? 1}`);
    }

    console.info(`Starting node server/wooky.mjs from ${appDir}...`);
    const child = spawn(
      process.execPath,
      [join(appDir, "server", "wooky.mjs"), "--port", "0", "--home", homeDir],
      {
        cwd: appDir,
        env: { ...process.env, WOOKY_SKIP_SHELL_ENV: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stderrText = "";
    child.stderr.on("data", (chunk) => {
      stderrText += String(chunk);
    });

    const url = await new Promise((resolveUrl, rejectUrl) => {
      let stdoutBuf = "";
      const timer = setTimeout(() => {
        rejectUrl(new Error(`Timed out waiting for WOOKY_LISTENING. stderr:\n${stderrText}`));
      }, STARTUP_TIMEOUT_MS);

      child.once("error", (err) => {
        clearTimeout(timer);
        rejectUrl(err);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        rejectUrl(
          new Error(
            `Server exited before listening (code=${code}, signal=${signal}). stderr:\n${stderrText}`,
          ),
        );
      });
      child.stdout.on("data", (chunk) => {
        stdoutBuf += String(chunk);
        for (const line of stdoutBuf.split(/\r?\n/)) {
          const match = /^WOOKY_LISTENING\s+(https?:\/\/\S+)/.exec(line.trim());
          if (match) {
            clearTimeout(timer);
            resolveUrl(match[1]);
            return;
          }
        }
      });
    });

    console.info(`WOOKY_LISTENING ${url}`);

    try {
      const healthRes = await fetch(`${url}/healthz`);
      const healthBody = await healthRes.text();
      if (healthRes.status !== 200 || healthBody !== "ok") {
        throw new Error(`Unexpected /healthz response: ${healthRes.status} ${healthBody}`);
      }

      const rootRes = await fetch(`${url}/`);
      const rootHtml = await rootRes.text();
      const contentType = rootRes.headers.get("content-type") ?? "";
      if (
        rootRes.status !== 200 ||
        !contentType.includes("text/html") ||
        !/<html/i.test(rootHtml)
      ) {
        throw new Error(
          `Unexpected / response: status=${rootRes.status} content-type=${contentType} body=${rootHtml.slice(0, 120)}`,
        );
      }
      console.info(
        `Smoke check passed: /healthz -> 200 ok; / -> 200 ${contentType} (${rootHtml.length} bytes)`,
      );
    } finally {
      await new Promise((done) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          done();
          return;
        }
        const killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(killTimer);
          done();
        });
        child.kill("SIGTERM");
      });
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
