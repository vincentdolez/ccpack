/**
 * Keys and logins can't travel. connect registers secret-filled copies of the servers that need
 * them, straight into ~/.claude.json (never on a command line, never in the project).
 */
import fs from "node:fs";
import { readPackage } from "./format.js";
import { existingServer, targets } from "./install.js";
import { Action, loadJournal, mergeJsonFile, saveJournal } from "./journal.js";
import { fillVars } from "./secrets.js";
import { claude, claudeJson, Emit, getAt, isObj, JsonObj, loadJson, writeJson } from "./util.js";

export type ServerState = { name: string; scope: string; vars: string[]; configured: boolean; health?: string };
export type Connections = { servers: ServerState[]; vars: string[]; connectors: string[] };

function context(projectArg: string) {
  const project = fs.realpathSync(projectArg);
  const j = loadJournal(project);
  if (!j) throw new Error("no ccpack install recorded for this project — run ccpack install first");
  const pkg = readPackage(j.packageDir);
  const t = targets(project, j.mode);
  const keyOf = (scope: string, name: string) => [...t.mcpKey(scope), name];
  const at = (k: string[]) => getAt(loadJson(claudeJson()), k);
  return { project, j, pkg, keyOf, at };
}

// TODO: install/connect/uninstall read-modify-write ~/.claude.json without a lock; a running Claude Code can race.

/** `claude mcp list` health, by server name. */
export function health(project: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of claude(project, "mcp", "list").out.split("\n")) {
    const m = line.match(/^(.+?): .* - (.+)$/);
    if (m) out[m[1].trim()] = m[2].replace(/^[^\p{L}]+/u, "").trim();
  }
  return out;
}

export function connections(projectArg: string, withHealth = false): Connections {
  const { project, pkg, keyOf, at } = context(projectArg);
  const h = withHealth ? health(project) : {};
  const servers = Object.entries(pkg.mcp).map(([name, e]) => ({
    name,
    scope: e.scope,
    vars: e.vars,
    configured: at(keyOf(e.scope, name)) !== undefined,
    health: h[name],
  }));
  const vars = [...new Set(servers.filter((s) => !s.configured).flatMap((s) => s.vars))];
  const connectors = pkg.manifest.items.filter((i) => i.kind === "connector").map((i) => i.name);
  return { servers, vars, connectors };
}

/** Registers the servers whose variables are all provided. Re-running replaces what ccpack registered before. */
export function applySecrets(projectArg: string, values: Record<string, string>, emit: Emit) {
  const { project, j, pkg, keyOf } = context(projectArg);
  emit("step", "Registering MCP servers with your keys");
  for (const [name, e] of Object.entries(pkg.mcp)) {
    if (!e.vars.length) continue;
    const missing = e.vars.filter((v) => !values[v]);
    if (missing.length) {
      emit("skip", name, `missing ${missing.join(", ")}`);
      continue;
    }
    const key = keyOf(e.scope, name);
    let replaced: Action | undefined;
    const ours = j.actions.findIndex((a) => a.t === "json" && a.path === claudeJson() && a.leaves.some(([k]) => k.length >= key.length && key.every((x, i) => k[i] === x)));
    const there = ours < 0 ? existingServer(project, name) : null;
    if (there) {
      emit("skip", name, `already defined in ${there} — kept`);
      continue;
    }
    if (ours >= 0) {
      // replace our previous registration (e.g. a mistyped key)
      const doc = loadJson(claudeJson());
      const parent = getAt(doc, key.slice(0, -1));
      if (isObj(parent)) delete parent[name];
      writeJson(claudeJson(), doc);
      replaced = j.actions.splice(ours, 1)[0];
    }
    const add = key.reduceRight<JsonObj>((acc, k) => ({ [k]: acc }), fillVars(e.config, values));
    const { action } = mergeJsonFile(claudeJson(), add);
    // containers the replaced registration created (e.g. mcpServers) still belong to ccpack
    if (action?.t === "json" && replaced?.t === "json") action.containers.push(...replaced.containers);
    if (action) j.actions.push(action);
    emit(action ? "ok" : "fail", name, key[0] === "mcpServers" ? "user scope" : "local scope");
  }
  saveJournal(j);
}
