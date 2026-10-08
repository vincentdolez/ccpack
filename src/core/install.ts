import fs from "node:fs";
import path from "node:path";
import { EXEC_KEYS, ExecKind, F, KINDS, Package, openPackage, readPackage } from "./format.js";
import { Action, JOURNAL_VERSION, Journal, loadJournal, mergeJsonFile, Mode, packageHome, saveJournal, writeBlock } from "./journal.js";
import { fillVars } from "./secrets.js";
import { uninstall } from "./uninstall.js";
import {
  claude, claudeDir, claudeJson, copyFile, Emit, exists, getAt, git, gitOk, isObj, resolvesInside, JsonObj, listFiles, loadJson, overlay, readText, sha256, slug, tilde,
} from "./util.js";

/** Where each layer lands, for a mode. One table, used by inspect and by install. */
export function targets(project: string, mode: Mode) {
  const cfg = claudeDir();
  const user = mode === "user";
  return {
    instructions: user ? path.join(cfg, "CLAUDE.md") : path.join(project, "CLAUDE.local.md"),
    kinds: user ? cfg : path.join(project, ".claude"),
    userSettings: user ? path.join(cfg, "settings.json") : path.join(project, ".claude", "settings.local.json"),
    localSettings: path.join(project, ".claude", "settings.local.json"),
    memory: path.join(cfg, "projects", slug(project), "memory"),
    pluginScope: user ? "user" : "local",
    /** Key path in ~/.claude.json for an MCP server packed from a given scope. */
    mcpKey: (scope: string) => (user && scope === "user" ? ["mcpServers"] : ["projects", project, "mcpServers"]),
  };
}

/** Where a server of this name already exists for the project, if anywhere — such a server is never touched. */
export function existingServer(project: string, name: string): string | null {
  const cj = loadJson(claudeJson());
  if (getAt(cj, ["projects", project, "mcpServers", name]) !== undefined) return "local scope";
  if (getAt(cj, ["mcpServers", name]) !== undefined) return "user scope";
  if (getAt(loadJson(path.join(project, ".mcp.json")), ["mcpServers", name]) !== undefined) return "the project's .mcp.json";
  return null;
}

const describeMcp = (c: JsonObj) => {
  const run = typeof c.command === "string" ? [c.command, ...((c.args as string[] | undefined) ?? [])].join(" ") : `${c.type} ${c.url}`;
  const env = isObj(c.env) ? Object.entries(c.env).map(([k, v]) => `${k}=${v}`) : [];
  const headers = isObj(c.headers) ? Object.entries(c.headers).map(([h, v]) => `header ${h}: ${v}`) : [];
  return [...env, run, ...headers].join(" ");
};

/**
 * Every command an executable part would run, as the receiver should read it.
 * TODO: itemise non-command hook types (prompt, agent, http) and hooks shipped inside git-marketplace plugins.
 */
function execLines(pkg: Package, kind: ExecKind): string[] {
  const sides = (["user", "local"] as const).map((s) => pkg.exec[s]);
  /** Values of every "command" key, at any depth (hooks and statusLine shapes). */
  const commands = (v: unknown): string[] =>
    Array.isArray(v) ? v.flatMap(commands) : isObj(v) ? Object.entries(v).flatMap(([k, x]) => (k === "command" && typeof x === "string" ? [x] : commands(x))) : [];
  switch (kind) {
    case "hooks":
      return [
        ...sides.flatMap((s) => (isObj(s.hooks) ? Object.entries(s.hooks).flatMap(([event, v]) => commands(v).map((c) => `${event}: ${c}`)) : [])),
        ...listFiles(path.join(pkg.dir, F.execFiles)).map((f) => `script ${f.replace(/^project\//, "").replace(/^user\//, "~/.claude/")}`),
      ];
    case "commands":
      return sides.flatMap((s) => [
        ...(s.statusLine !== undefined ? commands(s.statusLine).map((c) => `statusLine: ${c}`) : []),
        ...(typeof s.apiKeyHelper === "string" ? [`apiKeyHelper: ${s.apiKeyHelper}`] : []),
      ]);
    case "env":
      return sides.flatMap((s) => (isObj(s.env) ? Object.entries(s.env).map(([k, v]) => `${k}=${v}`) : []));
    case "marketplaces":
      return pkg.plugins.filter((p) => p.source.kind === "vendored").flatMap((p) => {
        const dir = path.join(pkg.dir, F.marketplaces, p.marketplace);
        const hooks = listFiles(dir).filter((f) => f.endsWith(path.join("hooks", "hooks.json")));
        const run = hooks.flatMap((f) => commands(loadJson(path.join(dir, f))).map((c) => `  runs ${c}`));
        const mcp = listFiles(dir).filter((f) => path.basename(f) === ".mcp.json").map((f) => `  declares MCP servers (${f})`);
        return [`${p.id} (bundled)`, ...run, ...mcp];
      });
  }
}

/** Everything a careful colleague wants to see before installing. */
export function inspect(pkg: Package, project?: string, mode: Mode = "project") {
  const m = pkg.manifest;
  const t = project ? targets(project, mode) : null;
  const to = (p: string) => (t ? ` → ${tilde(p)}` : "");
  const n = (d: string) => listFiles(path.join(pkg.dir, d)).length;
  const count = KINDS.map((k) => [k, exists(path.join(pkg.dir, k)) ? fs.readdirSync(path.join(pkg.dir, k)).length : 0] as const).filter(([, c]) => c);
  const perms = [pkg.settings, pkg.localSettings].map((s) => (isObj(s.permissions) ? s.permissions : {}));
  return {
    name: m.name, source: m.source, createdAt: m.createdAt, producer: m.producer, mode,
    layers: [
      ["Instructions", pkg.instructions ? `${pkg.instructions.split("\n").length} lines${t ? to(t.instructions) : ""}` : "none"],
      ["Skills & co", `${count.map(([k, c]) => `${c} ${k}`).join(", ") || "none"}${t ? to(t.kinds) : ""}`],
      ["Project files", `${n(F.files)} files git doesn't carry`],
      ["Settings", t ? tilde(t.userSettings) : "portable keys only"],
      ["Plugins", `${pkg.plugins.length}${t ? ` → scope ${t.pluginScope}` : ""}`],
      ["MCP servers", `${Object.keys(pkg.mcp).length} → ~/.claude.json`],
      ["Memory", `${n(F.memory)} files${t ? to(t.memory) : ""}`],
    ] as [string, string][],
    review: {
      mcp: Object.entries(pkg.mcp).map(([name, e]) => ({ name, scope: e.scope, runs: describeMcp(e.config), needs: e.vars })),
      plugins: pkg.plugins.map((p) => ({
        id: p.id,
        from: p.source.kind === "github" ? `github.com/${p.source.repo}` : p.source.kind === "git" ? p.source.url : "bundled in the package",
      })),
      permissions: perms.flatMap((p) => [
        ...((p.allow as string[] | undefined) ?? []).map((r) => `allow ${r}`),
        ...(p.defaultMode ? [`defaultMode ${p.defaultMode}`] : []),
        ...((p.additionalDirectories as string[] | undefined) ?? []).map((d) => `additionalDirectory ${d}`),
      ]),
      env: [pkg.settings, pkg.localSettings].flatMap((s) => (isObj(s.env) ? Object.entries(s.env).map(([k, v]) => `${k}=${v}`) : [])),
      files: listFiles(path.join(pkg.dir, F.files)).map((f) => ({ path: f, replaces: !!project && exists(path.join(project, f)) })),
      autoMode: [pkg.settings, pkg.localSettings].flatMap((s) =>
        isObj(s.autoMode) ? Object.entries(s.autoMode).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}: ${String(x)}`)) : []),
    },
    /** Executable parts the sender included: shown in full, installed only when accepted. */
    exec: m.exec.map((kind) => ({ kind, lines: execLines(pkg, kind) })),
    excluded: m.items.filter((i) => i.status !== "included").map((i) => ({ id: i.id, reason: i.reason ?? i.status })),
    warnings: m.warnings,
  };
}

export function install(pkgPath: string, projectArg: string, mode: Mode, emit: Emit, accept: ExecKind[] = []): Journal {
  const project = fs.realpathSync(projectArg);
  const opened = openPackage(pkgPath);
  if (loadJournal(project)) {
    emit("step", "Previous install found — removing it first");
    uninstall(project, emit);
  }
  // keep our own copy: connect and verify read it later, whatever happens to the original
  const home = packageHome(project);
  fs.rmSync(home, { recursive: true, force: true });
  fs.cpSync(opened.dir, home, { recursive: true });
  fs.rmSync(path.dirname(opened.dir), { recursive: true, force: true });
  const pkg = readPackage(home);
  const name = pkg.manifest.name;
  const accepted = (k: ExecKind) => accept.includes(k) && pkg.manifest.exec.includes(k);
  /** The executable settings of one side the receiver accepted, ${HOME} filled. */
  const execPart = (side: "user" | "local") =>
    fillVars(Object.fromEntries(Object.entries(pkg.exec[side]).filter(([k]) => accepted(EXEC_KEYS[k]))) as JsonObj, {});
  for (const k of pkg.manifest.exec) if (!accepted(k)) emit("info", `executable part "${k}" not installed`, `accept it with --accept ${k}`);
  const cfg = claudeDir();
  const t = targets(project, mode);
  const backups = path.join(cfg, "ccpack", "backups", path.basename(home), new Date().toISOString().replace(/[:.]/g, "-"));
  const j: Journal = { v: JOURNAL_VERSION, package: name, packageDir: home, mode, project, at: new Date().toISOString(), actions: [] };
  const act = (a: Action | null) => a && j.actions.push(a);
  const user = mode === "user";

  fs.mkdirSync(cfg, { recursive: true });
  const roots = [fs.realpathSync(project), fs.realpathSync(cfg)];
  /** Copies one file; an existing different file is backed up first. Never writes through a link out of the targets. */
  const put = (src: string, dst: string) => {
    if ((exists(dst) && fs.lstatSync(dst).isSymbolicLink()) || !resolvesInside(dst, roots))
      throw new Error(`refusing to write ${tilde(dst)}: it is a link, or leads outside the project and ${tilde(cfg)}`);
    const content = fs.readFileSync(src);
    if (exists(dst) && fs.readFileSync(dst).equals(content)) return;
    let backup: string | undefined;
    if (exists(dst)) {
      backup = path.join(backups, path.relative(path.parse(dst).root, dst));
      copyFile(dst, backup);
    }
    copyFile(src, dst);
    act({ t: "file", path: dst, sha: sha256(content), backup });
  };
  const merge = (file: string, add: JsonObj, label: string) => {
    const { action, conflicts } = mergeJsonFile(file, add);
    act(action);
    for (const c of conflicts) emit("skip", c, "yours kept");
    if (action) emit("ok", label);
  };

  try {
    emit("step", "Instructions");
    if (pkg.instructions) {
      act(writeBlock(t.instructions, `${name} ${tilde(project)}`, pkg.instructions));
      emit("ok", tilde(t.instructions));
    }

    emit("step", "Skills, agents, commands");
    for (const kind of KINDS) {
      const src = path.join(pkg.dir, kind);
      if (!exists(src)) continue;
      let c = 0;
      for (const e of fs.readdirSync(src)) {
        // a skill exists when its SKILL.md does — an empty leftover directory doesn't count
        const marker = kind === "skills" ? path.join(t.kinds, kind, e, "SKILL.md") : path.join(t.kinds, kind, e);
        if (exists(marker)) {
          emit("skip", `${kind}/${e}`, "already there — yours kept");
          continue;
        }
        const s = path.join(src, e);
        for (const f of fs.statSync(s).isDirectory() ? listFiles(s) : [""]) put(path.join(s, f), path.join(t.kinds, kind, e, f));
        c++;
      }
      emit("ok", `${c} ${kind}`, tilde(path.join(t.kinds, kind)));
    }

    emit("step", "Project files");
    const files = listFiles(path.join(pkg.dir, F.files));
    for (const f of files) put(path.join(pkg.dir, F.files, f), path.join(project, f));
    emit("ok", `${files.length} files`);

    emit("step", "Settings");
    if (user) {
      merge(t.userSettings, overlay(pkg.settings, execPart("user")) as JsonObj, tilde(t.userSettings));
      merge(t.localSettings, overlay(pkg.localSettings, execPart("local")) as JsonObj, ".claude/settings.local.json");
    } else merge(t.localSettings, [pkg.settings, execPart("user"), pkg.localSettings, execPart("local")].reduce((a, b) => overlay(a, b) as JsonObj), ".claude/settings.local.json");
    if (accepted("hooks")) {
      const hooks = listFiles(path.join(pkg.dir, F.execFiles));
      for (const f of hooks)
        put(path.join(pkg.dir, F.execFiles, f), f.startsWith("project/") ? path.join(project, f.slice("project/".length)) : path.join(cfg, f.slice("user/".length)));
      if (hooks.length) emit("ok", `${hooks.length} hook scripts`);
    }

    emit("step", "MCP servers");
    for (const [n, e] of Object.entries(pkg.mcp)) {
      if (e.vars.length) {
        emit("info", n, `needs ${e.vars.join(", ")} — connect step`);
        continue;
      }
      const key = t.mcpKey(e.scope);
      // a server is one unit: never merge into one the teammate already has
      const there = existingServer(project, n);
      if (there) {
        emit("skip", n, `already defined in ${there} — kept`);
        continue;
      }
      const add = key.reduceRight<JsonObj>((acc, k) => ({ [k]: acc }), { [n]: fillVars(e.config, {}) });
      const { action } = mergeJsonFile(claudeJson(), add);
      act(action);
      emit("ok", n, `${key[0] === "mcpServers" ? "user" : "local"} scope`);
    }

    emit("step", "Plugins");
    const enabled = (loadJson(t.userSettings).enabledPlugins ?? {}) as JsonObj;
    const known = loadJson(path.join(cfg, "plugins", "known_marketplaces.json"));
    for (const p of pkg.plugins) {
      if (p.source.kind === "vendored" && !accepted("marketplaces")) {
        emit("skip", p.id, "bundled local plugin — accept it with --accept marketplaces");
        continue;
      }
      if (enabled[p.id] === true) {
        emit("skip", p.id, "already enabled");
        continue;
      }
      if (!(p.marketplace in known)) {
        let src = p.source.kind === "github" ? p.source.repo : p.source.kind === "git" ? p.source.url : "";
        if (p.source.kind === "vendored") {
          src = path.join(cfg, "ccpack", "marketplaces", `${path.basename(home)}-${p.marketplace}`);
          fs.rmSync(src, { recursive: true, force: true });
          fs.cpSync(path.join(pkg.dir, p.source.dir), src, { recursive: true });
          act({ t: "dir", path: src });
        }
        if (claude(project, "plugin", "marketplace", "add", src, "--scope", t.pluginScope).ok) act({ t: "marketplace", name: p.marketplace, cwd: project });
      }
      const r = claude(project, "plugin", "install", p.id, "--scope", t.pluginScope);
      if (r.ok) act({ t: "plugin", id: p.id, scope: t.pluginScope, cwd: project });
      emit(r.ok ? "ok" : "fail", p.id, r.ok ? `scope ${t.pluginScope}` : r.out.trim().split("\n").pop());
    }

    emit("step", "Memory");
    let added = 0;
    for (const f of listFiles(path.join(pkg.dir, F.memory))) {
      const src = path.join(pkg.dir, F.memory, f);
      const dst = path.join(t.memory, f);
      if (f === "MEMORY.md" && exists(dst)) {
        const have = new Set(readText(dst).split("\n"));
        const lines = readText(src).split("\n").filter((l) => l.trim() && !have.has(l));
        if (lines.length) fs.appendFileSync(dst, (readText(dst).endsWith("\n") ? "" : "\n") + lines.join("\n") + "\n");
        for (const line of lines) act({ t: "line", path: dst, line });
      } else if (!exists(dst)) {
        put(src, dst);
        added++;
      }
    }
    emit("ok", `${added} files`, tilde(t.memory));

    emit("step", "Git");
    const top = git(project, "rev-parse", "--show-toplevel").trim();
    if (top) {
      const exclude = path.resolve(project, git(project, "rev-parse", "--git-path", "info/exclude").trim());
      const pats = new Set<string>();
      const rel = (p: string) => path.relative(top, p).split(path.sep).join("/");
      for (const a of j.actions) {
        if (a.t !== "file" || !a.path.startsWith(project + path.sep)) continue;
        const r = rel(a.path);
        const m = r.match(/^(.*?\.claude\/(?:skills|agents|commands|output-styles)\/[^/]+)\//);
        const pat = m ? m[1] : r;
        if (!git(top, "ls-files", "--", pat).trim()) pats.add("/" + pat + (m ? "/" : ""));
      }
      for (const f of [t.instructions, t.localSettings])
        if (f.startsWith(project + path.sep) && exists(f) && !git(top, "ls-files", "--", rel(f)).trim()) pats.add("/" + rel(f));
      const cur = exists(exclude) ? readText(exclude) : "";
      const have = new Set(cur.split("\n"));
      const fresh = [...pats].filter((p) => !have.has(p) && !gitOk(top, "check-ignore", "-q", p.slice(1).replace(/\/$/, "")));
      if (fresh.length) {
        fs.mkdirSync(path.dirname(exclude), { recursive: true });
        fs.appendFileSync(exclude, (cur && !cur.endsWith("\n") ? "\n" : "") + fresh.join("\n") + "\n");
        for (const line of fresh) act({ t: "line", path: exclude, line });
      }
      emit("ok", `${fresh.length} path${fresh.length === 1 ? "" : "s"} excluded`, "git info/exclude");
    } else emit("skip", "not in a git repository");
  } finally {
    saveJournal(j);
  }
  return j;
}
