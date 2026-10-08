/**
 * `ccpack <cmd> --json` prints one JSON object per line: progress events, then a result or an error.
 * The Ink UI runs commands as child processes speaking this protocol (core is synchronous and would
 * freeze rendering), so the UI, scripts and tests all go through the same code path.
 */
import type { Level } from "./core/util.js";

export type Event = { level: Level; label: string; detail?: string };
export type Line = Event | { result: unknown } | { error: string };

export function parseLine(l: string): Line | null {
  if (!l.trim()) return null;
  const v = JSON.parse(l);
  return "level" in v || "result" in v || "error" in v ? (v as Line) : null;
}
