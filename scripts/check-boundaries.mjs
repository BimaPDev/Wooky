#!/usr/bin/env node
// Architecture checks that a generic linter cannot express.
// Each rule encodes a project principle; see AGENTS.md "Boundaries".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const SKIP = new Set(["node_modules", "dist", "out", "release", ".git", ".age", ".age-dev"]);

function walk(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.(ts|tsx|mts)$/.test(name) && !name.endsWith(".d.ts")) files.push(full);
  }
  return files;
}

const files = ["packages", "apps"].flatMap((d) => walk(join(root, d)));
const violations = [];
const report = (file, line, rule, message) =>
  violations.push(`${relative(root, file)}:${line}  [${rule}] ${message}`);

const importRe =
  /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function imports(text) {
  const found = [];
  for (const m of text.matchAll(importRe)) {
    const spec = m[1] ?? m[2];
    const line = text.slice(0, m.index).split("\n").length + (m[0].startsWith("\n") ? 1 : 0);
    found.push({ spec, line });
  }
  return found;
}

const rules = [
  {
    id: "contracts-pure",
    applies: (rel) => rel.startsWith(`packages${sep}contracts${sep}`),
    imports: (spec) => spec === "zod" || spec.startsWith("."),
    message: "contracts may only import zod and local files",
  },
  {
    id: "domain-pure",
    applies: (rel) => rel.startsWith(`packages${sep}domain${sep}`),
    imports: (spec) => spec === "@age/contracts" || spec.startsWith(".") || spec === "vitest",
    message: "domain is pure: only @age/contracts and local files (no node:*, no I/O)",
  },
  {
    id: "web-no-server",
    applies: (rel) => rel.startsWith(`apps${sep}web${sep}`),
    imports: (spec) =>
      !spec.startsWith("node:") &&
      !spec.includes("apps/server") &&
      spec !== "@age/server" &&
      !["fs", "child_process", "path", "os"].includes(spec),
    message: "web is a remote control: no node built-ins or server imports",
  },
  {
    id: "server-no-web",
    applies: (rel) => rel.startsWith(`apps${sep}server${sep}`),
    imports: (spec) => !spec.includes("apps/web") && spec !== "@age/web" && spec !== "react",
    message: "server must not import UI code",
  },
];

for (const file of files) {
  const rel = relative(root, file);
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const isTest = /\.test\.tsx?$/.test(file);
  // File-level escape hatch, for the colour rule only: `// age-allow-file color: <reason>` on line 1.
  const allowFileColor = /\/\/\s*age-allow-file color:\s*\S/.test(lines[0] ?? "");

  for (const rule of rules) {
    if (!rule.applies(rel)) continue;
    for (const { spec, line } of imports(text)) {
      if (!rule.imports(spec)) report(file, line, rule.id, `${rule.message} (got "${spec}")`);
    }
  }

  lines.forEach((content, i) => {
    const line = i + 1;
    const allow = (id) => (lines[i - 1] ?? "").includes(`age-allow ${id}`);

    // Complexity lives at the adapter boundary: only adapters, git, terminal and the
    // desktop shell (which owns the server child) spawn processes.
    const relPosix = rel.split(sep).join("/");
    if (
      (relPosix.startsWith("apps/server/") || relPosix.startsWith("apps/desktop/")) &&
      /from\s+["'](node:)?child_process["']/.test(content) &&
      !/^apps\/server\/src\/(providers|git|terminal|process)\//.test(relPosix) &&
      !allow("child-process")
    ) {
      report(
        file,
        line,
        "spawn-boundary",
        "child_process only in server providers/, git/, terminal/, process/ (else age-allow)",
      );
    }

    // Never kill by pattern. Kill the PID you spawned.
    if (/\b(pkill|killall)\b|exec(Sync)?\(\s*[`'"]kill /.test(content) && !allow("kill")) {
      report(
        file,
        line,
        "no-pattern-kill",
        "kill only PIDs you spawned (no pkill/killall/kill strings)",
      );
    }

    // No shell strings: spawn with explicit argv.
    if (/\bshell:\s*true\b/.test(content) && !allow("shell")) {
      report(file, line, "no-shell", "spawn with argv, not shell: true");
    }

    // Tests wait on events, not wall-clock time.
    if (
      isTest &&
      /setTimeout\s*\(\s*(resolve|r|res)\b|\bsleep\s*\(/.test(content) &&
      !allow("sleep")
    ) {
      report(file, line, "no-sleep-in-tests", "await a specific event/promise instead of sleeping");
    }

    // React effects only sync with external systems, and must say which.
    if (
      rel.startsWith(`apps${sep}web${sep}`) &&
      /\buse(Layout)?Effect\s*\(/.test(content) &&
      !/sync:/.test(lines[i - 1] ?? "") &&
      !/sync:/.test(content)
    ) {
      report(
        file,
        line,
        "reasoned-effect",
        "useEffect needs a `// sync: <external system>` comment above it",
      );
    }

    // Colours come from tokens only (string literals like "#fff" or "rgb(...)" in components).
    if (
      rel.startsWith(`apps${sep}web${sep}src${sep}`) &&
      /["'`][^"'`\n]*(#[0-9a-fA-F]{3,8}\b|rgba?\()/.test(content) &&
      !allow("color") &&
      !allowFileColor
    ) {
      report(file, line, "tokens-only", "use a CSS variable from tokens.css, not a literal colour");
    }
  });
}

if (violations.length) {
  console.error(`Boundary check failed (${violations.length}):\n` + violations.join("\n"));
  process.exit(1);
}
console.info(`Boundary check passed (${files.length} files).`);
