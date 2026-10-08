import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT, ExecKind, F, FORMAT, Manifest, MARKER, McpEntry, PluginRef } from "./format.js";
import { collect, Item } from "./inventory.js";
import { scanSecrets } from "./secrets.js";
import { copyFile, copyTree, Emit, JsonObj, readText, tarCreate, tilde, writeFile, writeJson } from "./util.js";

/** From package.json — same relative path from src/core (tsx) and build/core. */
export const VERSION: string = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const DIR_OF = { skill: "skills", agent: "agents", command: "commands", "output-style": "output-styles" } as const;

/** Writes the package of `project` as <out>/<name>.ccpack.tar.gz. Staging happens in a temp dir, removed in all cases. */
export function pack(projectArg: string, out: string, opts: { excludeSkills?: string[]; include?: ExecKind[] }, emit: Emit) {
  const { project, items, warnings } = collect(projectArg, opts);
  const name = path.basename(project).replace(/[^A-Za-z0-9._-]/g, "-");
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ccpack-"));
  const pkg = path.join(staging, `${name}.ccpack`);
  const included = (kind: Item["kind"]) => items.filter((i) => i.kind === kind && i.status === "included");
  try {
    emit("step", "Instructions");
    const instr = included("instructions");
    // blocks another ccpack installed here are part of this setup now, but their markers must not nest
    const body = (i: Item) => readText(i.src!).trim().split(MARKER).join("<!-- (ccpack) ");
    if (instr.length) writeFile(path.join(pkg, F.instructions), instr.map((i) => `<!-- source: ${i.name} -->\n${body(i)}`).join("\n\n") + "\n");
    for (const i of instr) emit("ok", i.name);

    emit("step", "Project files outside git");
    const files = included("file").filter((i) => !i.exec);
    for (const i of files) copyFile(i.src!, path.join(pkg, F.files, i.name));
    emit("ok", `${files.length} files`, [...new Set(files.map((i) => i.reason))].join(", "));

    emit("step", "Skills, agents, commands");
    for (const kind of ["skill", "agent", "command", "output-style"] as const) {
      const list = included(kind);
      for (const i of list) copyTree(i.src!, path.join(pkg, DIR_OF[kind], path.basename(i.src!)));
      if (list.length) emit("ok", `${list.length} ${DIR_OF[kind]}`);
    }
    for (const i of items.filter((i) => i.kind in DIR_OF && i.status === "shadowed")) emit("skip", i.id, i.reason);

    emit("step", "Settings");
    const settings = (n: string) => items.find((i) => i.kind === "settings" && i.name === n)!.data;
    writeJson(path.join(pkg, F.settings), settings("user"));
    writeJson(path.join(pkg, F.localSettings), settings("local"));
    for (const i of items.filter((i) => i.kind === "settings" && i.status === "excluded" && !i.exec)) emit("skip", i.name, i.reason);

    emit("step", "Plugins");
    const plugins = included("plugin").map((i) => {
      const ref = i.data as unknown as PluginRef;
      if (ref.source.kind === "vendored") copyTree(i.src!, path.join(pkg, ref.source.dir));
      emit("ok", i.name, ref.source.kind === "github" ? ref.source.repo : ref.source.kind === "git" ? ref.source.url : "bundled — executable, opt-in");
      return ref;
    });
    writeJson(path.join(pkg, F.plugins), { plugins });

    const exec = items.filter((i) => i.exec && i.status === "included");
    if (exec.length) {
      emit("step", "Executable parts (opted in)");
      const parts: Record<string, JsonObj> = { user: {}, local: {} };
      for (const i of exec.filter((i) => i.kind === "settings")) parts[i.origin === "user" ? "user" : "local"][i.name.split(".")[1]] = i.data!;
      writeJson(path.join(pkg, F.exec), parts);
      for (const i of exec.filter((i) => i.kind === "file"))
        copyFile(i.src!, path.join(pkg, F.execFiles, i.origin === "user" ? `user/hooks/${i.name.replace("~/.claude/hooks/", "")}` : `project/${i.name}`));
      for (const k of new Set(exec.map((i) => i.exec!))) emit("ok", k, `${exec.filter((i) => i.exec === k).length} item(s) — the receiver decides`);
    }
    for (const i of items.filter((i) => i.exec && i.status === "excluded")) emit("skip", i.name, i.reason);

    emit("step", "MCP servers");
    const mcp: Record<string, McpEntry> = {};
    for (const i of included("mcp")) {
      mcp[i.name] = i.data as unknown as McpEntry;
      emit("ok", i.name, `${mcp[i.name].scope}${i.needs ? ` · needs ${i.needs.join(", ")}` : ""}`);
    }
    writeJson(path.join(pkg, F.mcp), mcp);

    emit("step", "Auto-memory");
    const mem = included("memory")[0];
    if (mem) emit("ok", `${copyTree(mem.src!, path.join(pkg, F.memory)).length} files`);
    else emit("skip", "none for this project");
    for (const w of warnings) emit("warn", w);

    const manifest: Manifest = {
      format: FORMAT, producer: `ccpack@${VERSION}`, agent: AGENT, name,
      source: tilde(project), createdAt: new Date().toISOString(),
      items: items.map(({ src, data, ...rest }) => rest),
      warnings,
      exec: [...new Set(items.filter((i) => i.exec && i.status === "included").map((i) => i.exec!))],
    };
    writeJson(path.join(pkg, F.manifest), manifest);

    emit("step", "Secret scan");
    const leaks = scanSecrets(pkg);
    if (leaks.length) {
      for (const l of leaks) emit("fail", l);
      throw new Error(`secrets found — package not written:\n${leaks.join("\n")}`);
    }
    emit("ok", "clean");
    fs.mkdirSync(out, { recursive: true });
    const tgz = path.join(out, `${name}.ccpack.tar.gz`);
    tarCreate(pkg, tgz);
    return { tgz, size: fs.statSync(tgz).size, warnings, items: manifest.items };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
