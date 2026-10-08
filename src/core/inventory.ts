/**
 * What shapes Claude Code on one project, as a flat list of items. Read-only: `pack` writes
 * these into a package; other commands (a graph, a session miner) can reuse the same list.
 */
import fs from "node:fs";
import path from "node:path";
import { EXEC_KEYS, ExecKind, KINDS, McpEntry, McpScope, PluginRef, PROJECT_FILE } from "./format.js";
import { sanitizeSettings, templatizeMcp } from "./secrets.js";
import { claudeDir, claudeJson, exists, git, home, isFile, Json, JsonObj, listFiles, loadJson, overlay, readText, slug, tilde } from "./util.js";

export type ItemKind =
  | "instructions" | "skill" | "agent" | "command" | "output-style"
  | "file" | "settings" | "plugin" | "mcp" | "memory" | "connector";
export type Origin = "user" | "parent" | "project" | "local" | "account";

export type Item = {
  id: string; // `${kind}:${name}` — stable join key
  kind: ItemKind;
  name: string;
  origin: Origin;
  status: "included" | "excluded" | "shadowed";
  reason?: string;
  needs?: string[]; // variables the colleague must provide
  src?: string; // absolute path on this machine — never written to a package
  data?: Json; // structured payload (settings, MCP entry, plugin ref)
  exec?: ExecKind; // runs code on the receiver: travels only on opt-in
};

const SINGULAR = { skills: "skill", agents: "agent", commands: "command", "output-styles": "output-style" } as const;
/** Project paths that never travel: machine state, and local settings (collected apart, sanitized). */
const PROJECT_SKIP = /^\.claude\/(settings\.local\.json|worktrees\/|RESUME\.md)|(^|\/)(\.DS_Store$|__pycache__\/|node_modules\/|\.venv\/)/;

export function collect(projectArg: string, opts: { excludeSkills?: string[]; include?: ExecKind[] } = {}) {
  const project = fs.realpathSync(projectArg);
  const opted = (k: ExecKind) => opts.include?.includes(k) ?? false;
  /** Status and reason of an executable item, from the sender's opt-in. */
  const execStatus = (k: ExecKind) =>
    opted(k) ? { status: "included" as const, reason: `executable (${k}) — the receiver decides` } : { status: "excluded" as const, reason: `executable — include with --include ${k}` };
  const cfg = claudeDir();
  const items: Item[] = [];
  const warnings: string[] = [];
  const add = (i: Omit<Item, "id">) => items.push({ id: `${i.kind}:${i.name}`, ...i });

  // Instructions, in Claude Code's load order: user, user rules, parent directories, CLAUDE.local.md.
  const instr = (name: string, origin: Origin, src: string) => isFile(src) && add({ kind: "instructions", name, origin, status: "included", src });
  instr("~/.claude/CLAUDE.md", "user", path.join(cfg, "CLAUDE.md"));
  const rules = path.join(cfg, "rules");
  if (exists(rules))
    for (const r of fs.readdirSync(rules, { recursive: true }).map(String).filter((f) => f.endsWith(".md")).sort())
      instr(`~/.claude/rules/${r}`, "user", path.join(rules, r));
  const parents: string[] = [];
  for (let d = path.dirname(project); ; d = path.dirname(d)) {
    parents.unshift(d);
    if (d === path.dirname(d)) break;
  }
  for (const d of parents) for (const f of ["CLAUDE.md", "CLAUDE.local.md"]) instr(tilde(path.join(d, f)), "parent", path.join(d, f));
  instr("CLAUDE.local.md", "project", path.join(project, "CLAUDE.local.md"));
  for (const i of items)
    for (const m of readText(i.src!).matchAll(/^@(\S+)/gm)) warnings.push(`${i.name} imports @${m[1]} — not resolved, check it exists on the target`);

  // Project files git won't carry: modified, untracked or gitignored, under .claude/ and instruction files.
  const scope = ["--", ".claude", "AGENTS.md", ":(glob)**/CLAUDE.md"];
  const found = new Map<string, string>();
  for (const [why, args] of [
    ["modified", ["ls-files", "--modified"]],
    ["untracked", ["ls-files", "--others", "--exclude-standard"]],
    ["gitignored", ["ls-files", "--others", "--ignored", "--exclude-standard"]],
  ] as const)
    for (const rel of git(project, ...args, ...scope).split("\n").filter(Boolean)) found.set(rel, why);
  for (const [rel, why] of [...found].sort()) {
    if (PROJECT_SKIP.test(rel) || !isFile(path.join(project, rel))) continue;
    if (why === "gitignored" && rel.endsWith("CLAUDE.md") && !rel.startsWith(".claude/"))
      add({ kind: "instructions", name: rel, origin: "project", status: "excluded", reason: "gitignored sub-directory — usually private data" });
    else if (PROJECT_FILE.test(rel)) add({ kind: "file", name: rel, origin: "project", status: "included", reason: why, src: path.join(project, rel) });
    else if (rel.startsWith(".claude/hooks/")) add({ kind: "file", name: rel, origin: "project", exec: "hooks", src: path.join(project, rel), ...execStatus("hooks") });
    else if (rel === ".claude/settings.json") add({ kind: "file", name: rel, origin: "project", status: "excluded", reason: `${why} — its keys travel with the local settings` });
    else add({ kind: "file", name: rel, origin: "project", status: "excluded", reason: `${why} — not a Claude Code instruction or item` });
  }
  // the project's shared settings, when git doesn't carry them as they are here, travel as local settings
  const sharedRaw = found.has(".claude/settings.json") ? loadJson(path.join(project, ".claude", "settings.json")) : {};
  for (const rel of listFiles(path.join(cfg, "hooks")))
    add({ kind: "file", name: `~/.claude/hooks/${rel}`, origin: "user", exec: "hooks", src: path.join(cfg, "hooks", rel), ...execStatus("hooks") });

  // User skills, agents, commands, output styles.
  for (const dir of KINDS) {
    const src = path.join(cfg, dir);
    if (!exists(src)) continue;
    const kind = SINGULAR[dir];
    for (const e of fs.readdirSync(src).sort()) {
      const p = path.join(src, e);
      if (e.startsWith(".")) continue;
      if (dir === "skills" && e === "synced") {
        add({ kind: "skill", name: "synced/*", origin: "account", status: "excluded", reason: "pushed by the claude.ai account — the colleague's account decides" });
        continue;
      }
      if (dir === "skills" ? !isFile(path.join(p, "SKILL.md")) && !exists(path.join(fs.realpathSync(p), "SKILL.md")) : !e.endsWith(".md")) continue;
      const name = dir === "skills" ? e : e.replace(/\.md$/, "");
      const status =
        dir === "skills" && opts.excludeSkills?.includes(e) ? "excluded"
        : exists(path.join(project, ".claude", dir, e)) ? "shadowed"
        : "included";
      add({
        kind, name, origin: "user", status, src: p,
        reason: status === "shadowed" ? "the project has its own" : status === "excluded" ? "excluded on request" : fs.lstatSync(p).isSymbolicLink() ? `symlink → ${tilde(fs.realpathSync(p))}` : undefined,
      });
    }
  }

  // Settings: portable keys only. User level (with ~/.claude/settings.local.json) and project-local, kept apart.
  const userRaw = loadJson(path.join(cfg, "settings.json"));
  const user = sanitizeSettings(overlay(userRaw, loadJson(path.join(cfg, "settings.local.json"))) as JsonObj);
  const local = sanitizeSettings(overlay(sharedRaw, loadJson(path.join(project, ".claude", "settings.local.json"))) as JsonObj);
  add({ kind: "settings", name: "user", origin: "user", status: "included", data: user.clean });
  add({ kind: "settings", name: "local", origin: "local", status: "included", data: local.clean });
  for (const [o, e] of [["user", user.exec], ["local", local.exec]] as const)
    for (const [k, v] of Object.entries(e)) add({ kind: "settings", name: `${o}.${k}`, origin: o, data: v, exec: EXEC_KEYS[k], ...execStatus(EXEC_KEYS[k]) });
  for (const [o, d] of [["user", user.dropped], ["local", local.dropped]] as const)
    for (const k of d.filter((x) => !/^(enabledPlugins|extraKnownMarketplaces) /.test(x)))
      add({ kind: "settings", name: `${o}.${k.split(" ")[0]}`, origin: o, status: "excluded", reason: k.slice(k.indexOf(" ") + 1).replace(/[()]/g, "") });
  const dirs = [local.clean, loadJson(path.join(project, ".claude", "settings.json"))]
    .flatMap((s) => ((s.permissions as JsonObj | undefined)?.additionalDirectories ?? []) as string[]);
  for (const d of dirs) warnings.push(`additionalDirectories ${d}: the colleague needs it next to the project`);

  // Plugins enabled at user level. GitHub/git marketplaces by reference, local directories vendored.
  const markets = { ...loadJson(path.join(cfg, "plugins", "known_marketplaces.json")), ...((userRaw.extraKnownMarketplaces ?? {}) as JsonObj) } as Record<
    string, { source?: { source?: string; repo?: string; path?: string; url?: string } }
  >;
  for (const [id, on] of Object.entries((userRaw.enabledPlugins ?? {}) as JsonObj)) {
    if (on !== true) continue;
    const marketplace = id.split("@")[1] ?? "";
    const s = markets[marketplace]?.source ?? {};
    let ref: PluginRef | null = null;
    if (s.source === "github" && s.repo) ref = { id, marketplace, source: { kind: "github", repo: s.repo } };
    else if ((s.source === "git" || s.source === "url") && s.url?.startsWith("https://"))
      ref = { id, marketplace, source: { kind: "git", url: s.url.replace(/\/\/[^/@]+@/, "//") } };
    else if (s.source === "directory" && s.path && exists(s.path)) {
      ref = { id, marketplace, source: { kind: "vendored", dir: `marketplaces/${marketplace}` } };
      add({ kind: "plugin", name: id, origin: "user", data: ref as unknown as Json, src: s.path, exec: "marketplaces", ...execStatus("marketplaces") });
      continue;
    }
    if (ref) add({ kind: "plugin", name: id, origin: "user", status: "included", data: ref as unknown as Json });
    else add({ kind: "plugin", name: id, origin: "user", status: "excluded", reason: "marketplace source not reproducible" });
  }

  // MCP servers from the three file scopes; later scopes win, as in Claude Code (local > project > user).
  const cj = loadJson(claudeJson());
  const projects = (cj.projects ?? {}) as Record<string, JsonObj>;
  const layers: [McpScope, JsonObj][] = [
    ["user", (cj.mcpServers ?? {}) as JsonObj],
    ["project", (loadJson(path.join(project, ".mcp.json")).mcpServers ?? {}) as JsonObj],
    ["local", (projects[project]?.mcpServers ?? {}) as JsonObj],
  ];
  const mcp = new Map<string, Item>();
  for (const [scope, layer] of layers)
    for (const [name, c] of Object.entries(layer)) {
      const prev = mcp.get(name);
      if (prev) (prev.status = "shadowed"), (prev.reason = `overridden by ${scope} scope`), (prev.id += `@${prev.origin}`);
      const t = templatizeMcp(name, c as JsonObj);
      const entry: McpEntry = { scope, ...t };
      const origin: Origin = scope === "project" ? "project" : scope;
      const item: Item = { id: `mcp:${name}`, kind: "mcp", name, origin, status: "included", needs: t.vars.length ? t.vars : undefined, data: entry as unknown as Json };
      items.push(item);
      mcp.set(name, item);
    }
  for (const c of ((cj.claudeAiMcpEverConnected ?? []) as string[]).filter((x) => !/Claude Code Remote/.test(x)))
    add({ kind: "connector", name: c.replace(/^claude\.ai /, ""), origin: "account", status: "excluded", reason: "enable it on claude.ai with the colleague's account" });

  // Auto-memory: memory/ only, transcripts stay home.
  const mem = path.join(cfg, "projects", slug(project), "memory");
  if (exists(mem)) {
    add({ kind: "memory", name: "auto-memory", origin: "user", status: "included", src: mem });
    for (const f of fs.readdirSync(mem)) if (isFile(path.join(mem, f)) && readText(path.join(mem, f)).includes(home() + "/"))
      warnings.push(`memory/${f} mentions paths under ${tilde(home())}`);
  }
  return { project, items, warnings };
}
