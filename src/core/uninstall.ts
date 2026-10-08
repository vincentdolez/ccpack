import fs from "node:fs";
import { Action, journalPath, loadJournal, saveJournal, undo } from "./journal.js";
import { Emit, tilde } from "./util.js";

/** Reverts a recorded install. Actions that fail (a CLI call) stay in the journal for a retry. */
export function uninstall(projectArg: string, emit: Emit) {
  const project = fs.realpathSync(projectArg);
  const j = loadJournal(project);
  if (!j) throw new Error("no ccpack install recorded for this project");
  emit("step", `Removing ${j.package} (${j.mode} mode, ${j.actions.length} changes)`);
  const failed: Action[] = [];
  let files = 0;
  let undone = 0;
  for (const a of [...j.actions].reverse()) {
    const r = undo(a);
    if (r.failed) (failed.unshift(a), emit("fail", r.failed, "will retry on next uninstall"));
    if (r.kept) emit("warn", `kept ${tilde(r.kept)}`);
    if (r.label) (undone++, a.t === "file" ? files++ : emit("ok", tilde(r.label).replace(project, ".")));
  }
  if (files) emit("ok", `${files} files removed or restored`);
  if (failed.length) saveJournal({ ...j, actions: failed });
  else {
    fs.rmSync(journalPath(project));
    fs.rmSync(j.packageDir, { recursive: true, force: true });
  }
  return { undone, failed: failed.length };
}
