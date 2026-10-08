#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { render } from "ink";
import React from "react";
import { EXEC, ExecKind } from "./core/format.js";
import { Mode } from "./core/journal.js";
import { VERSION } from "./core/pack.js";
import { Level } from "./core/util.js";
import { Args, COMMANDS, run } from "./run.js";
import App, { Screen } from "./ui/App.js";

const HELP = `ccpack ${VERSION} — hand a colleague your Claude Code setup for one project

  ccpack                                    interactive menu
  ccpack pack [project] [-o dir]            → <dir>/<project>.ccpack.tar.gz (default dir: the project's parent)
        [--exclude-skill name]… [--include hooks,marketplaces,env,commands|all]
  ccpack inspect <pkg.tar.gz> [project]     what's inside, what would run, where it would land
  ccpack install <pkg.tar.gz> [project] [--mode project|user] [--accept hooks,marketplaces,env,commands|all]
  ccpack connect [project] [--check]        keys for MCP servers; scripts: CCPACK_SECRETS='{"VAR":"…"}'
  ccpack verify [project] [--live]          --live: one claude -p call checks what a session loads
  ccpack uninstall [project]                revert exactly what install changed

  Executable parts (hooks, bundled local plugins, env vars beyond Claude Code switches, statusLine/
  apiKeyHelper) are opt-in twice: --include when packing, --accept when installing, after inspect.

  --json   one JSON event per line          --yes   no prompts (install mode defaults to project)

Unofficial — not affiliated with Anthropic.`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", short: "o" },
    mode: { type: "string" },
    live: { type: "boolean" },
    check: { type: "boolean" },
    json: { type: "boolean" },
    yes: { type: "boolean", short: "y" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    "exclude-skill": { type: "string", multiple: true },
    include: { type: "string", multiple: true },
    accept: { type: "string", multiple: true },
  },
});

if (o.help || o.version) {
  console.log(o.version ? VERSION : HELP);
  process.exit(0);
}
const [cmd = "", ...pos] = positionals;
if (o.mode && o.mode !== "project" && o.mode !== "user") {
  console.error("--mode must be project or user");
  process.exit(2);
}
/** "--include hooks,env --include commands" → validated kinds; "all" for every kind. */
const kinds = (flag: string, v: string[] | undefined): ExecKind[] => {
  const list = (v ?? []).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
  if (list.includes("all")) return [...EXEC];
  const bad = list.filter((x) => !(EXEC as readonly string[]).includes(x));
  if (bad.length) (console.error(`--${flag}: unknown ${bad.join(", ")} (use ${EXEC.join(", ")} or all)`), process.exit(2));
  return list as ExecKind[];
};
const args: Args = {
  cmd, pos, out: o.out, mode: o.mode as Mode | undefined, live: o.live, check: o.check, excludeSkill: o["exclude-skill"] ?? [],
  include: kinds("include", o.include), accept: kinds("accept", o.accept),
};
const interactive = process.stdout.isTTY && process.stdin.isTTY && !o.json && !o.yes;
const UI = ["", "pack", "install", "connect", "verify", "uninstall"];

if (interactive && UI.includes(cmd)) {
  const project = path.resolve((cmd === "install" ? pos[1] : pos[0]) ?? ".");
  const initial: Screen =
    cmd === "" ? { s: "home" }
    : cmd === "install" ? (pos[0] ? { s: "install", pkg: pos[0], project, mode: args.mode } : { s: "ask-package", project })
    : cmd === "verify" ? { s: "verify", project, live: !!o.live }
    : ({ s: cmd, project } as Screen);
  render(<App initial={initial} />);
} else {
  const ICON: Record<Level, string> = { step: "⏺", ok: "  ✓", warn: "  !", skip: "  –", fail: "  ✗", info: "  ·" };
  const emit = o.json
    ? (level: Level, label: string, detail?: string) => console.log(JSON.stringify({ level, label, detail }))
    : (level: Level, label: string, detail?: string) => console.log(`${ICON[level]} ${label}${detail ? `  (${detail})` : ""}`);
  try {
    if (!COMMANDS.includes(cmd)) throw new Error(cmd ? `unknown command "${cmd}"\n\n${HELP}` : HELP);
    const result = run(args, emit);
    if (o.json) console.log(JSON.stringify({ result }));
    else if (cmd === "pack") console.log(`\n${(result as { tgz: string }).tgz}`);
    else if (cmd === "inspect") console.log(JSON.stringify(result, null, 2));
    process.exit(cmd === "verify" && !(result as { ok: boolean }).ok ? 1 : 0);
  } catch (e) {
    const msg = (e as Error).message;
    if (o.json) console.log(JSON.stringify({ error: msg }));
    else console.error(msg);
    process.exit(1);
  }
}
