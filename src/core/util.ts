import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObj = { [k: string]: Json };

/** Progress reporting shared by every command; the UI renders it, the plain CLI prints it. */
export type Level = "step" | "ok" | "warn" | "skip" | "fail" | "info";
export type Emit = (level: Level, label: string, detail?: string) => void;

export const home = () => os.homedir();
export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(home(), ".claude");
export const claudeJson = () =>
  process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home(), ".claude.json");
/** "~/x" for display and for anything written into a package. */
export const tilde = (p: string) => (p === home() || p.startsWith(home() + path.sep) ? "~" + p.slice(home().length) : p);

/** Directory name Claude Code derives from an absolute project path. */
export const slug = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");
export const sha256 = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

export const exists = (p: string) => fs.existsSync(p);
export const isFile = (p: string) => fs.existsSync(p) && fs.lstatSync(p).isFile();
export const readText = (p: string) => fs.readFileSync(p, "utf8");
export const isObj = (v: unknown): v is JsonObj => !!v && typeof v === "object" && !Array.isArray(v);
/** Value at a key path, or undefined. */
export const getAt = (doc: unknown, keys: string[]): Json | undefined =>
  keys.reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), doc) as Json | undefined;

export function loadJson(p: string): JsonObj {
  if (!exists(p)) return {};
  const v = JSON.parse(readText(p));
  return isObj(v) ? v : {};
}

/**
 * Atomic write (temp + rename); keeps the mode of the file it replaces. With `follow`, writes
 * through an existing symlink (dotfile managers link ~/.claude.json, settings.json…).
 */
export function writeFile(target: string, content: string | Buffer, mode?: number, follow = false) {
  const p = follow && exists(target) && fs.lstatSync(target).isSymbolicLink() ? fs.realpathSync(target) : target;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const m = mode ?? (exists(p) ? fs.statSync(p).mode & 0o777 : 0o644);
  const tmp = `${p}.ccpack-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: m });
  fs.chmodSync(tmp, m);
  fs.renameSync(tmp, p);
}

/** JSON configs are written through symlinks; see writeFile. */
export const writeJson = (p: string, v: unknown, mode?: number) => writeFile(p, JSON.stringify(v, null, 2) + "\n", mode, true);

/** True when `p` resolves (through any symlinked parent) inside one of `roots`. */
export function resolvesInside(p: string, roots: string[]): boolean {
  let d = p;
  while (!exists(d)) d = path.dirname(d);
  const real = path.join(fs.realpathSync(d), path.relative(d, p));
  return roots.some((r) => real === r || real.startsWith(r + path.sep));
}

export const copyFile = (src: string, dst: string) => writeFile(dst, fs.readFileSync(src), fs.statSync(src).mode & 0o777);

/** Merge where `top` wins on scalars; objects merge, arrays union. */
export function overlay(base: Json, top: Json): Json {
  if (isObj(base) && isObj(top)) {
    const out: JsonObj = { ...base };
    for (const [k, v] of Object.entries(top)) out[k] = k in base ? overlay(base[k], v) : v;
    return out;
  }
  if (Array.isArray(base) && Array.isArray(top)) {
    const seen = new Set(base.map((x) => JSON.stringify(x)));
    return [...base, ...top.filter((x) => !seen.has(JSON.stringify(x)))];
  }
  return top;
}

const SKIP_NAMES = new Set([".DS_Store", "__pycache__", "node_modules", ".venv", ".git"]);

/** Files under `dir` (relative paths). Symlinks are skipped, or rejected when `strict`. */
export function listFiles(dir: string, strict = false): string[] {
  if (!exists(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isSymbolicLink()) {
        if (strict) throw new Error(`invalid package: symlink ${r}`);
        continue;
      }
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

/** Copies a file or directory, following symlinks at the source (user skills are often links), skipping caches. */
export function copyTree(src: string, dst: string): string[] {
  const out: string[] = [];
  const walk = (s: string, d: string, rel: string) => {
    if (fs.statSync(s).isDirectory()) {
      for (const e of fs.readdirSync(s)) if (!SKIP_NAMES.has(e)) walk(path.join(s, e), path.join(d, e), path.join(rel, e));
    } else {
      copyFile(s, d);
      out.push(rel);
    }
  };
  walk(fs.realpathSync(src), dst, "");
  return out;
}

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
}
export const gitOk = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, ...args]).status === 0;

/** Runs the claude CLI with an argument vector (no shell). Never throws. */
export function claude(cwd: string, ...args: string[]) {
  const r = spawnSync("claude", args, { cwd, encoding: "utf8", timeout: 180_000 });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

export function tarCreate(dir: string, tgz: string) {
  // no AppleDouble files nor macOS xattrs: they surface as noise and stray entries on Linux
  const mac = process.platform === "darwin" ? ["--no-mac-metadata", "--no-xattrs"] : [];
  execFileSync("tar", ["czf", tgz, ...mac, "-C", path.dirname(dir), path.basename(dir)], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
}
