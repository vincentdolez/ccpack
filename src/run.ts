import fs from "node:fs";
import path from "node:path";
import { applySecrets, connections } from "./core/connect.js";
import { ExecKind, openPackage } from "./core/format.js";
import { inspect, install } from "./core/install.js";
import { Mode } from "./core/journal.js";
import { pack } from "./core/pack.js";
import { uninstall } from "./core/uninstall.js";
import { Emit } from "./core/util.js";
import { verify } from "./core/verify.js";

export type Args = {
  cmd: string; pos: string[]; out?: string; mode?: Mode; live?: boolean; check?: boolean; excludeSkill: string[];
  include: ExecKind[]; accept: ExecKind[];
};

export const COMMANDS = ["pack", "inspect", "install", "connect", "verify", "uninstall"];

/** Runs one command headlessly and returns its result. Secrets for `connect` come only from CCPACK_SECRETS (JSON). */
export function run(a: Args, emit: Emit): unknown {
  const at = (i: number) => path.resolve(a.pos[i] ?? ".");
  const need = (i: number, usage: string) => a.pos[i] ?? (() => { throw new Error(`usage: ccpack ${usage}`); })();
  switch (a.cmd) {
    case "pack": {
      const r = pack(at(0), path.resolve(a.out ?? path.dirname(at(0))), { excludeSkills: a.excludeSkill, include: a.include }, emit);
      return { tgz: r.tgz, size: r.size, warnings: r.warnings };
    }
    case "inspect": {
      const pkg = openPackage(need(0, "inspect <package.tar.gz> [project] [--mode project|user]"));
      try {
        return inspect(pkg, a.pos[1] ? at(1) : undefined, a.mode ?? "project");
      } finally {
        fs.rmSync(path.dirname(pkg.dir), { recursive: true, force: true });
      }
    }
    case "install": {
      const j = install(need(0, "install <package.tar.gz> [project] [--mode project|user]"), at(1), a.mode ?? "project", emit, a.accept);
      return { actions: j.actions.length, ...connections(j.project) };
    }
    case "connect": {
      if (!a.check) {
        const values = JSON.parse(process.env.CCPACK_SECRETS || "{}") as Record<string, string>;
        delete process.env.CCPACK_SECRETS; // child processes (claude mcp list starts every server) must not inherit it
        if (Object.keys(values).length) applySecrets(at(0), values, emit);
        else emit("info", "no secret provided", "interactive: ccpack connect · scripts: CCPACK_SECRETS='{\"VAR\":\"…\"}'");
      }
      return connections(at(0), true);
    }
    case "verify":
      return { ok: verify(at(0), !!a.live, emit) };
    case "uninstall":
      return uninstall(at(0), emit);
    default:
      throw new Error(`unknown command "${a.cmd}" — try ccpack --help`);
  }
}
