/**
 * The package contract — what `pack` writes and `install` reads. Documented in FORMAT.md.
 * Everything read from a package is untrusted: names and paths are validated here, once.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Item } from "./inventory.js";
import { sanitizeSettings } from "./secrets.js";
import { JsonObj, listFiles, loadJson } from "./util.js";

export const FORMAT = 1;
export const AGENT = "claude-code";
export const KINDS = ["skills", "agents", "commands", "output-styles"] as const;
export type Kind = (typeof KINDS)[number];
/**
 * Parts that run code on the receiver's machine. Opt-in on both sides: the sender chooses what to
 * include, the receiver chooses what to accept after seeing it.
 */
export const EXEC = ["hooks", "marketplaces", "env", "commands"] as const;
export type ExecKind = (typeof EXEC)[number];
/** Settings keys carried by each executable kind. */
export const EXEC_KEYS: Record<string, ExecKind> = { hooks: "hooks", env: "env", statusLine: "commands", apiKeyHelper: "commands" };

/** Package layout, relative to the package root. */
export const F = {
  manifest: "manifest.json",
  instructions: "instructions.md",
  settings: "settings.json", // portable keys of ~/.claude/settings.json (+ settings.local.json)
  localSettings: "settings.local.json", // portable keys of <project>/.claude/settings.local.json
  mcp: "mcp.json",
  plugins: "plugins.json",
  files: "files", // project files git won't carry, by path relative to the project
  memory: "memory",
  exec: "exec.json", // { user: {hooks?, env?, statusLine?, apiKeyHelper?}, local: {…} }
  execFiles: "exec-files", // project/.claude/hooks/… and user/hooks/… scripts
  marketplaces: "marketplaces", // local plugin marketplaces, bundled
} as const;

export type Manifest = {
  format: number;
  producer: string;
  agent: string;
  name: string;
  source: string; // where it was packed from, home-relative
  createdAt: string;
  items: Item[];
  warnings: string[];
  exec: ExecKind[]; // executable kinds the sender included
};

export type McpScope = "project" | "user" | "local";
export type McpEntry = { scope: McpScope; config: JsonObj; vars: string[] };
export type PluginSource = { kind: "github"; repo: string } | { kind: "git"; url: string } | { kind: "vendored"; dir: string };
export type PluginRef = { id: string; marketplace: string; source: PluginSource };

export type Package = {
  dir: string;
  manifest: Manifest;
  mcp: Record<string, McpEntry>;
  plugins: PluginRef[];
  settings: JsonObj;
  localSettings: JsonObj;
  exec: { user: JsonObj; local: JsonObj };
  instructions?: string;
};

/** Names that end up in paths or CLI arguments. */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
/** Project files a package may carry — instructions and on-demand items only; never settings or hook scripts. */
export const PROJECT_FILE = /^(\.claude\/(skills|agents|commands|output-styles|rules)\/.+|\.claude\/CLAUDE\.md|([^/]+\/)*CLAUDE\.md|AGENTS\.md)$/;
export const MARKER = "<!-- ccpack:";

const fail = (msg: string): never => {
  throw new Error(`invalid package: ${msg}`);
};
const safeName = (what: string, n: string) => (SAFE_NAME.test(n) ? n : fail(`${what} ${JSON.stringify(n)}`));

/** Reads and validates an extracted package directory. */
export function readPackage(dir: string): Package {
  const manifest = loadJson(path.join(dir, F.manifest)) as unknown as Manifest;
  if (manifest.agent !== AGENT) fail("not a ccpack package for Claude Code");
  if (typeof manifest.format !== "number" || manifest.format > FORMAT)
    fail(`format ${manifest.format} is newer than this ccpack supports (${FORMAT}) — upgrade ccpack`);
  safeName("name", manifest.name);
  manifest.exec = (manifest.exec ?? []).filter((k) => (EXEC as readonly string[]).includes(k));
  const has = (k: ExecKind) => manifest.exec.includes(k);

  for (const rel of listFiles(dir, true)) {
    const p = rel.split(path.sep).join("/");
    const [top, ...rest] = p.split("/");
    const sub = rest.join("/");
    const ok =
      Object.values(F).includes(p as never) ||
      (top === F.files && PROJECT_FILE.test(sub)) ||
      (top === F.memory && rest.length >= 1) ||
      (top === F.execFiles && has("hooks") && /^(project\/\.claude\/hooks|user\/hooks)\/.+/.test(sub)) ||
      (top === F.marketplaces && has("marketplaces") && rest.length >= 2 && SAFE_NAME.test(rest[0])) ||
      ((KINDS as readonly string[]).includes(top) && rest.length >= 1 && SAFE_NAME.test(rest[0]));
    if (!ok || p.split("/").some((seg) => seg === ".." || seg === ".git")) fail(`unexpected file ${p}`);
  }

  const mcp = loadJson(path.join(dir, F.mcp)) as unknown as Record<string, McpEntry>;
  for (const [n, e] of Object.entries(mcp)) {
    safeName("MCP server", n);
    if (!["project", "user", "local"].includes(e.scope)) fail(`MCP server ${n}: scope`);
    e.config = mcpShape(n, e.config);
    e.vars = (e.vars ?? []).map((v) => (/^[A-Z][A-Z0-9_]*$/.test(v) ? v : fail(`variable ${v}`)));
  }
  const plugins = (loadJson(path.join(dir, F.plugins)).plugins ?? []) as unknown as PluginRef[];
  for (const p of plugins) {
    safeName("plugin", p.id);
    safeName("marketplace", p.marketplace);
    const s = p.source;
    if (s?.kind === "github") /^[\w.-]+\/[\w.-]+$/.test(s.repo) || fail(`plugin source ${s.repo}`);
    else if (s?.kind === "git") /^https:\/\/[^\s@]+$/.test(s.url) || fail(`plugin source ${s.url}`);
    else if (s?.kind === "vendored") (has("marketplaces") && s.dir === `${F.marketplaces}/${p.marketplace}`) || fail(`plugin source ${s.dir}`);
    else fail(`plugin source for ${p.id}`);
  }
  const instructions = fs.existsSync(path.join(dir, F.instructions)) ? fs.readFileSync(path.join(dir, F.instructions), "utf8") : undefined;
  if (instructions?.includes(MARKER)) fail("instructions contain a ccpack marker");
  // the sender's pack filtered settings already; a crafted package is filtered again here
  const settings = sanitizeSettings(loadJson(path.join(dir, F.settings)));
  const localSettings = sanitizeSettings(loadJson(path.join(dir, F.localSettings)));
  for (const d of [...settings.dropped, ...localSettings.dropped]) manifest.warnings.push(`setting refused on install: ${d}`);
  for (const e of [settings.exec, localSettings.exec])
    for (const [k, v] of Object.entries(e))
      for (const name of k === "env" && v && typeof v === "object" ? Object.keys(v).map((x) => `env.${x}`) : [k])
        manifest.warnings.push(`setting refused on install: ${name} (executable parts only come from exec.json)`);
  // executable settings: only the keys of the kinds the manifest declares
  const execRaw = loadJson(path.join(dir, F.exec));
  const exec = { user: {} as JsonObj, local: {} as JsonObj };
  for (const side of ["user", "local"] as const) {
    const part = execRaw[side];
    if (part === undefined) continue;
    if (!part || typeof part !== "object" || Array.isArray(part)) fail(`exec.${side}`);
    for (const [k, v] of Object.entries(part as JsonObj)) {
      const kind = EXEC_KEYS[k];
      if (!kind || !has(kind)) fail(`exec.${side}.${k} not declared in the manifest`);
      exec[side][k] = v;
    }
  }
  return { dir, manifest, mcp, plugins, settings: settings.clean, localSettings: localSettings.clean, exec, instructions };
}

const CONTROL = /[\u0000-\u001f\u007f\u009b]/;
const str = (n: string, k: string, v: unknown) => (typeof v === "string" && !CONTROL.test(v) ? v : fail(`MCP server ${n}: ${k}`));

/** An MCP config is either stdio (command + args) or remote (http/sse + url), with string env and headers — nothing else. */
function mcpShape(n: string, c: unknown): JsonObj {
  if (!c || typeof c !== "object" || Array.isArray(c)) fail(`MCP server ${n}`);
  const cfg = c as Record<string, unknown>;
  for (const k of Object.keys(cfg)) if (!["type", "command", "args", "url", "env", "headers"].includes(k)) fail(`MCP server ${n}: key ${k}`);
  const out: JsonObj = {};
  const remote = cfg.url !== undefined;
  if (remote) {
    if (cfg.command !== undefined || cfg.args !== undefined || !["http", "sse"].includes(cfg.type as string)) fail(`MCP server ${n}: a remote server has type http|sse, a url, and no command`);
    out.type = cfg.type as string;
    out.url = str(n, "url", cfg.url);
  } else {
    if (cfg.type !== undefined && cfg.type !== "stdio") fail(`MCP server ${n}: type`);
    out.command = str(n, "command", cfg.command);
    if (cfg.args !== undefined) out.args = (Array.isArray(cfg.args) ? cfg.args : fail(`MCP server ${n}: args`)).map((a) => str(n, "args", a));
  }
  for (const k of ["env", "headers"] as const)
    if (cfg[k] !== undefined) {
      const o = cfg[k];
      if (!o || typeof o !== "object" || Array.isArray(o)) fail(`MCP server ${n}: ${k}`);
      out[k] = Object.fromEntries(Object.entries(o as object).map(([x, v]) => [str(n, k, x), str(n, `${k}.${x}`, v)]));
    }
  return out;
}

/**
 * Extracts a .tar.gz into a fresh temp directory. Entries must all live under one
 * `<name>.ccpack/` folder, be regular files or directories, and stay inside it.
 */
export function extract(tgz: string): string {
  const listing = execFileSync("tar", ["tvzf", tgz], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const names = execFileSync("tar", ["tzf", tgz], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    .split("\n").filter(Boolean).map((n) => n.replace(/^\.\//, ""));
  const top = names[0]?.split("/")[0];
  if (!top || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.ccpack$/.test(top)) fail("archive must contain a single <name>.ccpack/ folder");
  for (const n of names) if (path.isAbsolute(n) || n.split("/").includes("..") || n.split("/")[0] !== top) fail(`archive entry ${n}`);
  for (const line of listing.split("\n").filter(Boolean)) if (!/^[-d]/.test(line)) fail(`links are not allowed (${line.slice(0, 60)}…)`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccpack-"));
  execFileSync("tar", ["xzf", tgz, "-C", tmp], { stdio: ["ignore", "ignore", "ignore"] });
  return path.join(tmp, top);
}

/** Package path (dir or .tar.gz) → validated package in a temp directory. */
export function openPackage(p: string): Package {
  const abs = path.resolve(p);
  let dir: string;
  if (fs.statSync(abs).isDirectory()) {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccpack-")), path.basename(abs));
    fs.cpSync(abs, dir, { recursive: true, verbatimSymlinks: true });
  } else dir = extract(abs);
  return readPackage(dir);
}
