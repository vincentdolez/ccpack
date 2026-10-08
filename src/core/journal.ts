/**
 * Every change install makes is recorded here, at the finest grain (one file, one JSON leaf,
 * one line), so uninstall reverts exactly that — and keeps whatever changed since.
 */
import fs from "node:fs";
import path from "node:path";
import { claude, claudeDir, claudeJson, exists, getAt, isObj, UNSAFE_KEY, Json, JsonObj, loadJson, readText, sha256, slug, writeFile, writeJson } from "./util.js";

type Key = string[];
export type Action =
  | { t: "file"; path: string; sha: string; backup?: string }
  | { t: "block"; path: string; id: string; created: boolean }
  // values are stored as hashes: the journal never holds a copy of a key typed in connect
  | { t: "json"; path: string; leaves: [Key, string][]; items: [Key, string][]; containers: Key[]; created: boolean; before?: string; afterSha: string }
  | { t: "line"; path: string; line: string }
  | { t: "dir"; path: string }
  | { t: "plugin"; id: string; scope: string; cwd: string }
  | { t: "marketplace"; name: string; cwd: string };

export type Mode = "project" | "user";
export const JOURNAL_VERSION = 1;
export type Journal = { v: number; package: string; packageDir: string; mode: Mode; project: string; at: string; actions: Action[] };

const id = (project: string) => `${slug(project).slice(-80)}-${sha256(project).slice(0, 8)}`;
export const journalPath = (project: string) => path.join(claudeDir(), "ccpack", "installs", `${id(project)}.json`);
/** Where install keeps its copy of the package (connect and verify read it later). */
export const packageHome = (project: string) => path.join(claudeDir(), "ccpack", "packages", id(project));
export const loadJournal = (project: string): Journal | null =>
  exists(journalPath(project)) ? (loadJson(journalPath(project)) as unknown as Journal) : null;
export const saveJournal = (j: Journal) => writeJson(journalPath(j.project), j, 0o600);
/** Files whose full text is never copied into the journal (they hold other secrets). */
const PRIVATE = () => [claudeJson()];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const h = (v: unknown) => sha256(JSON.stringify(v));
const isEmpty = (v: Json | undefined) => (isObj(v) && !Object.keys(v).length) || (Array.isArray(v) && !v.length);

/**
 * Merges `add` into the JSON file at `p`. Existing values win (the colleague's choices are kept);
 * arrays get the missing items. Returns the action recording each added leaf, and the conflicts.
 */
export function mergeJsonFile(p: string, add: JsonObj): { action: Action | null; conflicts: string[] } {
  const created = !exists(p);
  const before = created || PRIVATE().includes(p) ? undefined : readText(p);
  const doc = loadJson(p);
  const a = { leaves: [] as [Key, string][], items: [] as [Key, string][], containers: [] as Key[] };
  const conflicts: string[] = [];
  const walk = (dst: JsonObj, src: JsonObj, at: Key) => {
    for (const [k, v] of Object.entries(src)) {
      if (UNSAFE_KEY.has(k)) continue;
      const kp = [...at, k];
      if (!Object.hasOwn(dst, k)) {
        if (isObj(v)) {
          dst[k] = {};
          a.containers.push(kp);
        } else if (Array.isArray(v)) {
          dst[k] = [];
          a.containers.push(kp);
        } else {
          dst[k] = v;
          a.leaves.push([kp, h(v)]);
          continue;
        }
      }
      const d = dst[k];
      if (isObj(d) && isObj(v)) walk(d, v, kp);
      else if (Array.isArray(d) && Array.isArray(v)) {
        for (const x of v) if (!d.some((y) => same(x, y))) d.push(x), a.items.push([kp, h(x)]);
      } else if (!same(d, v)) conflicts.push(`${kp.join(".")}: kept ${JSON.stringify(d)}`);
    }
  };
  walk(doc, add, []);
  if (!a.leaves.length && !a.items.length) return { action: null, conflicts };
  writeJson(p, doc, created && PRIVATE().includes(p) ? 0o600 : undefined);
  return { action: { t: "json", path: p, ...a, created, before, afterSha: sha256(readText(p)) }, conflicts };
}

export const blockMarks = (blockId: string) => [`<!-- ccpack:begin ${blockId} -->`, `<!-- ccpack:end ${blockId} -->`];

/** Writes (or replaces) a marked block at the end of a text file. */
export function writeBlock(p: string, blockId: string, body: string): Action {
  const created = !exists(p);
  const [b, e] = blockMarks(blockId);
  const cur = created ? "" : stripBlock(readText(p), blockId);
  const sep = !cur ? "" : cur.endsWith("\n\n") ? "" : cur.endsWith("\n") ? "\n" : "\n\n";
  writeFile(p, `${cur}${sep}${b}\n${body.trim()}\n${e}\n`);
  return { t: "block", path: p, id: blockId, created };
}

export function stripBlock(txt: string, blockId: string): string {
  const [b, e] = blockMarks(blockId);
  const i = txt.indexOf(b);
  const j = txt.indexOf(e, i);
  if (i < 0 || j < 0) return txt;
  const head = txt.slice(0, i).replace(/\n+$/, "");
  const tail = txt.slice(j + e.length).replace(/^\n+/, "");
  return head && tail ? `${head}\n\n${tail}` : head ? `${head}\n` : tail;
}

export type Undo = { label?: string; kept?: string; failed?: string };

/** Reverts one action. `kept`: left in place because it changed since install; `failed`: retry later. */
export function undo(a: Action): Undo {
  switch (a.t) {
    case "file": {
      if (!exists(a.path)) return {};
      if (sha256(fs.readFileSync(a.path)) !== a.sha) return { kept: `${a.path} (modified since install)` };
      if (a.backup && exists(a.backup)) {
        writeFile(a.path, fs.readFileSync(a.backup));
        return { label: `restored ${a.path}` };
      }
      fs.rmSync(a.path);
      pruneEmptyDirs(path.dirname(a.path));
      return { label: `removed ${a.path}` };
    }
    case "block": {
      if (!exists(a.path)) return {};
      const txt = stripBlock(readText(a.path), a.id);
      if (a.created && !txt.trim()) fs.rmSync(a.path);
      else writeFile(a.path, txt);
      return { label: `block removed from ${a.path}` };
    }
    case "json": {
      if (!exists(a.path)) return {};
      if (sha256(readText(a.path)) === a.afterSha && (a.before !== undefined || a.created)) {
        // untouched since install: give back the exact original bytes
        if (a.before === undefined) fs.rmSync(a.path);
        else writeFile(a.path, a.before, undefined, true); // through a symlink, like every config write
        return { label: `restored ${a.path}` };
      }
      const doc = loadJson(a.path);
      for (const [k, item] of a.items) {
        const arr = getAt(doc, k);
        if (Array.isArray(arr)) {
          const i = arr.findIndex((x) => h(x) === item);
          if (i >= 0) arr.splice(i, 1);
        }
      }
      const drop = (k: Key, when: (v: Json) => boolean) => {
        const parent = getAt(doc, k.slice(0, -1));
        const last = k[k.length - 1];
        if (isObj(parent) && last in parent && when(parent[last])) delete parent[last];
      };
      for (const [k, v] of a.leaves) drop(k, (x) => h(x) === v);
      for (const k of [...a.containers].sort((x, y) => y.length - x.length)) drop(k, isEmpty);
      // keys a CLI left empty after its own uninstall (e.g. "enabledPlugins": {}) that weren't there before
      // what the file held before install: known when ccpack created it or kept a copy
      const was = a.before ? (JSON.parse(a.before) as JsonObj) : a.created ? {} : null;
      if (was) for (const [k, v] of Object.entries(doc)) if (!(k in was) && isEmpty(v)) delete doc[k];
      if (a.created && !Object.keys(doc).length) fs.rmSync(a.path);
      else writeJson(a.path, doc);
      return { label: `reverted ccpack keys in ${a.path}` };
    }
    case "line": {
      if (!exists(a.path)) return {};
      const lines = readText(a.path).split("\n");
      const i = lines.indexOf(a.line);
      if (i >= 0) lines.splice(i, 1), writeFile(a.path, lines.join("\n"));
      return {};
    }
    case "dir":
      if (a.path.startsWith(path.join(claudeDir(), "ccpack") + path.sep)) fs.rmSync(a.path, { recursive: true, force: true });
      return {};
    case "plugin":
      return claude(a.cwd, "plugin", "uninstall", a.id, "--scope", a.scope).ok ? { label: `plugin ${a.id} uninstalled` } : { failed: `plugin ${a.id}` };
    case "marketplace":
      return claude(a.cwd, "plugin", "marketplace", "remove", a.name).ok ? { label: `marketplace ${a.name} removed` } : { failed: `marketplace ${a.name}` };
  }
}

function pruneEmptyDirs(d: string) {
  // stop at .claude itself, its direct children (skills/, agents/…) and memory/
  const root = (x: string) => path.basename(x) === ".claude" || path.basename(path.dirname(x)) === ".claude" || path.basename(x) === "memory";
  while (exists(d) && fs.readdirSync(d).length === 0 && !root(d)) {
    fs.rmdirSync(d);
    d = path.dirname(d);
  }
}
