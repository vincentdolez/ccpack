import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { F, readPackage } from "./format.js";
import { targets } from "./install.js";
import { loadJournal } from "./journal.js";
import { claude, Emit, exists, isFile, readText, tilde } from "./util.js";

/** Static checks always; with `live`, one `claude -p` call (needs auth) checks what a session actually loads. */
export function verify(projectArg: string, live: boolean, emit: Emit): boolean {
  const project = fs.realpathSync(projectArg);
  const j = loadJournal(project);
  if (!j) throw new Error("no ccpack install recorded for this project");
  const pkg = readPackage(j.packageDir);
  let ok = true;
  const check = (cond: boolean, label: string, detail?: string) => {
    emit(cond ? "ok" : "fail", label, detail);
    ok &&= cond;
  };

  emit("step", "Files");
  const files = j.actions.filter((a) => a.t === "file");
  const missing = files.filter((a) => !exists(a.path));
  check(!missing.length, `${files.length - missing.length}/${files.length} installed files present`, missing[0] && tilde(missing[0].path));
  const mem = path.join(targets(project, j.mode).memory, "MEMORY.md");
  if (exists(path.join(pkg.dir, F.memory))) check(isFile(mem), "memory index in place", tilde(mem));

  emit("step", "Plugins");
  const listed = claude(project, "plugin", "list").out;
  for (const p of pkg.plugins) check(listed.includes(p.id.split("@")[0]), p.id);

  if (!live) return ok;

  emit("step", "Live session (claude -p)");
  const memTitle = exists(path.join(pkg.dir, F.memory, "MEMORY.md"))
    ? readText(path.join(pkg.dir, F.memory, "MEMORY.md")).match(/^- \[([^\]]+)\]/m)?.[1]
    : undefined;
  // a heading and the line under it: quoting that line proves the instructions are in context
  const hm = pkg.instructions?.match(/^## (.+)\n+(.+)$/m);
  const heading = hm?.[1].trim();
  const firstLine = hm?.[2].replace(/^[-*>\s]+|\*\*/g, "").trim().slice(0, 40);
  const r = spawnSync(
    "claude",
    ["-p", "--output-format", "stream-json", "--verbose", "--max-turns", "1",
      `Without using any tool, answer only with a one-line JSON object: {"memory_first": <exact title of the first entry of your auto-memory MEMORY.md index>, "first_line": <the first line under the section titled ${JSON.stringify(heading ?? "")} in your instructions, verbatim, or null>}`],
    { cwd: project, encoding: "utf8", timeout: 300_000 },
  );
  const events = (r.stdout || "").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  const init = events.find((e) => e.subtype === "init");
  const answer: string = events.find((e) => e.type === "result")?.result ?? "";
  if (!init) {
    check(false, "claude -p failed", (r.stderr || r.stdout || "").trim().split("\n").pop());
    return false;
  }
  const want = (kind: string) => (exists(path.join(pkg.dir, kind)) ? fs.readdirSync(path.join(pkg.dir, kind)).map((n) => n.replace(/\.md$/, "")) : []);
  const haveSkills = [...(init.skills ?? []), ...(init.slash_commands ?? [])].map((s: string) => s.split(":").pop());
  const skills = [...want("skills"), ...want("commands")];
  const lost = skills.filter((s) => !haveSkills.includes(s));
  check(!lost.length, `skills loaded ${skills.length - lost.length}/${skills.length}`, lost.join(", "));
  const agents = want("agents");
  if (agents.length) {
    const lostA = agents.filter((a) => !(init.agents ?? []).includes(a));
    check(!lostA.length, `agents loaded ${agents.length - lostA.length}/${agents.length}`, lostA.join(", "));
  }
  const havePlugins = (init.plugins ?? []).map((p: { name: string }) => p.name);
  for (const p of pkg.plugins) check(havePlugins.includes(p.id.split("@")[0]), `plugin ${p.id} loaded`);
  for (const s of init.mcp_servers ?? [])
    if (s.name in pkg.mcp) emit(s.status === "connected" ? "ok" : "info", `MCP ${s.name}`, s.status);
  if (memTitle) check(answer.includes(memTitle), "memory recalled", memTitle);
  if (firstLine) check(answer.replace(/\*\*/g, "").includes(firstLine), "instructions loaded", `${heading} → ${firstLine}…`);
  if (/has not been trusted/.test(r.stderr || ""))
    emit("info", "folder not trusted yet: project permissions are ignored until you open claude here once and accept");
  return ok;
}
