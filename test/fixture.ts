import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLine } from "../src/protocol.js";

export const ROOT = path.resolve(import.meta.dirname, "..");
// built by concatenation so the repo itself holds no secret-shaped literal (push protection)
export const SECRETS = {
  mcpEnv: "GOCSPX" + "-" + "abcdefghijklmnopqrstuv",
  mcpHeader: "gh" + "p_" + "a".repeat(36),
  localScope: "sk-" + "ant-api03-" + "b".repeat(30),
  settingsEnv: "xox" + "b-1234567890-abcdefghij",
  argKey: "Zx9" + "q".repeat(20) + "7Lm",
  urlToken: "tok" + "9".repeat(20) + "abc",
  urlPass: "hunter" + "2pass",
  dbPass: "pg" + "-pass-" + "z".repeat(8),
  localEnvKey: "sk-" + "proj-" + "c".repeat(40),
  bearer: "Bearer " + "d".repeat(30),
  gitCred: "glpat-" + "e".repeat(20),
  pathToken: "T0k" + "f".repeat(25) + "9",
  shortPat: "pat" + "1234567890ab",
  b64: "QUJD" + "ZGVm/" + "R0hJ".repeat(8) + "==",
  ruleKey: "abcd" + "1234".repeat(6),
};

export const slug = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");

export function w(p: string, content: string | object) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

export function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

export const tmpdir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccpack-test-")));

/** Source machine: HOME with ~/.claude, a project repo with every layer that matters — and secrets everywhere. */
export function sourceMachine(tmp: string) {
  const home = path.join(tmp, "src-home");
  const c = path.join(home, ".claude");
  const p = path.join(home, "work", "client", "proj");
  w(path.join(home, "work", "CLAUDE.md"), "## Parent rule\n- parent-level instruction\n");
  w(path.join(c, "CLAUDE.md"), "## Core Rules\n- user-level instruction\n\n<!-- ccpack:begin other ~/x -->\nfrom a previous install\n<!-- ccpack:end other ~/x -->\n");
  w(path.join(c, "rules", "style.md"), "## Style rule\n- terse\n");
  w(path.join(c, "settings.json"), {
    language: "fr", effortLevel: "high", theme: "light", model: "claude-sonnet-4-5-20250929",
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", FEATURE_FLAG: "1", PATH: "/opt/bin:/usr/bin", BASH_ENV: "/tmp/x.sh",
      SLACK_BOT_TOKEN: SECRETS.settingsEnv, DB_PASS: SECRETS.dbPass, ANTHROPIC_BASE_URL: "https://proxy.corp",
    },
    permissions: { allow: ["Bash(ls:*)", `Bash(curl -H 'Authorization: ${SECRETS.bearer}' x)`, `Bash(export API_KEY=${SECRETS.ruleKey} && run)`], defaultMode: "bypassPermissions" },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "/Applications/X.app/hook" }] }] },
    statusLine: { type: "command", command: "echo hi" },
    enabledPlugins: { "gh-plugin@gh-market": true, "dir-plugin@dir-market": true, "git-plugin@git-market": true, "off@gh-market": false },
    extraKnownMarketplaces: {
      "dir-market": { source: { source: "directory", path: path.join(home, "mkt") } },
      "git-market": { source: { source: "git", url: `https://oauth2:${SECRETS.gitCred}@gitlab.example/mkt.git` } },
    },
  });
  w(path.join(c, "settings.local.json"), { permissions: { allow: ["Bash(glab api:*)"] } });
  w(path.join(c, "plugins", "known_marketplaces.json"), { "gh-market": { source: { source: "github", repo: "acme/market" } } });
  w(path.join(home, "mkt", ".claude-plugin", "marketplace.json"), { name: "dir-market", plugins: [{ name: "dir-plugin", source: "./" }] });
  w(path.join(c, "skills", "user-skill", "SKILL.md"), "---\nname: user-skill\n---\nbody\n");
  w(path.join(home, "elsewhere", "linked-skill", "SKILL.md"), "---\nname: linked-skill\n---\nbody\n");
  w(path.join(home, "elsewhere", "linked-skill", "agents", "helper.md"), "nested dir named like a .claude kind\n");
  fs.symlinkSync(path.join(home, "elsewhere", "linked-skill"), path.join(c, "skills", "linked-skill"));
  w(path.join(c, "skills", "synced", "org_user", "docx", "SKILL.md"), "account skill");
  w(path.join(c, "skills", "shadowed", "SKILL.md"), "user version");
  w(path.join(c, "agents", "user-agent.md"), "---\nname: user-agent\n---\n");

  const mem = path.join(c, "projects", slug(p), "memory");
  w(path.join(mem, "MEMORY.md"), "# Memory\n\n- [Slow machine](slow-machine.md) — agents-1 is slow\n");
  w(path.join(mem, "slow-machine.md"), "agents-1 is slow, wait 120 s\n");
  w(path.join(c, "projects", slug(p), "session.jsonl"), "transcript — must not travel\n");

  w(path.join(home, ".claude.json"), {
    mcpServers: {
      ctx: { type: "http", url: "https://ctx.example/mcp", headers: { Authorization: "Bearer " + SECRETS.mcpHeader } },
      remote: { type: "http", url: `https://user:${SECRETS.urlPass}@api.example/mcp?apiKey=${SECRETS.urlToken}&region=eu` },
    },
    projects: {
      [p]: {
        mcpServers: {
          "local-srv": { command: "srv", env: { API_KEY: SECRETS.localScope } },
          "plain-srv": { command: "plain", args: ["--dir", path.join(home, "data")] },
          "arg-srv": { command: "npx", args: ["tool", "--api-key", SECRETS.argKey, "--verbose"] },
          gchat: { command: "uvx", args: ["override"] },
          "shapes-srv": { type: "http", url: `https://hooks.example/v1/${SECRETS.pathToken}/sse` },
          "pat-srv": { command: "tool", args: ["--pat", SECRETS.shortPat, "--b64", SECRETS.b64] },
        },
      },
    },
    claudeAiMcpEverConnected: ["claude.ai Gmail", "claude.ai Claude Code Remote"],
  });

  sh("git", ["init", "-q", p]);
  w(path.join(p, "CLAUDE.md"), "## Project\n- project instruction\n");
  w(path.join(p, ".gitignore"), ".mcp.json\n.claude/settings.local.json\n.claude/skills/ignored-skill/\n");
  w(path.join(p, ".claude", "settings.json"), { permissions: { deny: ["Read(./.env)"] } });
  w(path.join(p, ".claude", "skills", "tracked", "SKILL.md"), "v1\n");
  w(path.join(p, ".claude", "skills", "shadowed", "SKILL.md"), "project version\n");
  sh("git", ["add", "-A"], { cwd: p });
  sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: p });
  w(path.join(p, ".claude", "skills", "tracked", "SKILL.md"), "v2 uncommitted\n");
  w(path.join(p, ".claude", "skills", "untracked", "SKILL.md"), "new\nexample: xoxb-your-token-here\nAuthorization: Bearer sk_live_abc123...\n");
  w(path.join(p, ".claude", "skills", "ignored-skill", "SKILL.md"), "ignored but used\n");
  w(path.join(p, ".claude", "hooks", "guard.py"), "print('hook')\n");
  w(path.join(p, ".claude", "skills", "ignored-skill", "__pycache__", "x.pyc"), "junk");
  w(path.join(p, ".claude", "settings.local.json"), {
    permissions: { allow: ["WebSearch"] }, enableAllProjectMcpServers: true,
    env: { OPENAI_API_KEY: SECRETS.localEnvKey, MODE: "dev" },
    hooks: { PreToolUse: [] }, apiKeyHelper: "/bin/get-key",
  });
  w(path.join(p, ".mcp.json"), {
    mcpServers: {
      gchat: { command: "uvx", env: { GOOGLE_OAUTH_CLIENT_ID: "123.apps.googleusercontent.com", GOOGLE_OAUTH_CLIENT_SECRET: SECRETS.mcpEnv, WORKSPACE_MCP_CREDENTIALS_DIR: path.join(home, ".creds") } },
      docs: { command: "docs-mcp", env: { LOG_LEVEL: "error" } },
    },
  });
  return { home, claude: c, project: p };
}

/** Colleague machine: a clone elsewhere, a stub claude CLI that logs its calls, existing personal config. */
export function colleagueMachine(tmp: string, sourceProject: string) {
  const home = path.join(tmp, "colleague");
  const cfg = path.join(home, ".claude");
  const clone = path.join(home, "code", "proj-clone");
  sh("git", ["clone", "-q", sourceProject, clone]);
  w(path.join(clone, ".claude", "settings.local.json"), { permissions: { allow: ["Bash(make:*)"] }, model: "sonnet", language: "en" });
  w(path.join(cfg, "CLAUDE.md"), "## My own rules\n- colleague rule\n");
  w(path.join(cfg, "settings.json"), { language: "en", permissions: { allow: ["Bash(npm:*)"] } });
  w(path.join(cfg, "skills", "user-skill", "SKILL.md"), "colleague's own user-skill\n");
  fs.mkdirSync(path.join(cfg, "skills", "linked-skill", "agents"), { recursive: true }); // empty leftover, not a skill
  w(path.join(cfg, ".claude.json"), { mcpServers: { docs: { command: "colleague-docs" } }, numStartups: 3 });
  const mem = path.join(cfg, "projects", slug(clone), "memory");
  w(path.join(mem, "MEMORY.md"), "# Memory\n\n- [Mine](mine.md) — colleague fact\n");
  const bin = path.join(tmp, "bin");
  const log = path.join(tmp, "claude.log");
  w(path.join(bin, "claude"), `#!/bin/sh
echo "$PWD|$*" >> "${log}"
case "$1 $2" in
  "plugin list") cat "${tmp}/plugins.state" 2>/dev/null ;;
  "plugin install") echo "$3" >> "${tmp}/plugins.state"
    [ "$5" = local ] && node -e 'const f=".claude/settings.local.json",fs=require("fs");const s=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):{};(s.enabledPlugins??={})[process.argv[1]]=true;fs.writeFileSync(f,JSON.stringify(s,null,2))' "$3" ;;
  "plugin uninstall") [ "$5" = local ] && node -e 'const f=".claude/settings.local.json",fs=require("fs");if(fs.existsSync(f)){const s=JSON.parse(fs.readFileSync(f));delete (s.enabledPlugins??{})[process.argv[1]];fs.writeFileSync(f,JSON.stringify(s,null,2))}' "$3" ;;
  "mcp list") echo "ENV:\${CCPACK_SECRETS:-}" >> "${log}"; echo "plain-srv: plain - ✔ Connected"; echo "ctx: https://ctx.example/mcp (HTTP) - ! Needs authentication" ;;
esac
exit 0
`);
  fs.chmodSync(path.join(bin, "claude"), 0o755);
  // already installed for another project of the colleague: must still be enabled for this one
  w(path.join(tmp, "plugins.state"), "gh-plugin@gh-market\n");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: cfg, PATH: `${bin}:${process.env.PATH}` };
  delete env.CCPACK_SECRETS;
  return { home, cfg, clone, mem, log, env, claudeJson: path.join(cfg, ".claude.json") };
}

/** Runs the ccpack CLI in --json mode; returns events and the final result. */
export function ccpack(args: string[], env: NodeJS.ProcessEnv, allowFail = false) {
  const r = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "src", "cli.tsx"), ...args, "--json"], { encoding: "utf8", env, cwd: ROOT });
  const lines = (r.stdout || "").split("\n").map(parseLine).filter((l) => l !== null);
  const result = (lines.find((l) => "result" in l) as { result: any } | undefined)?.result;
  const error = (lines.find((l) => "error" in l) as { error: string } | undefined)?.error;
  if (!allowFail && (r.status !== 0 || error)) throw new Error(`ccpack ${args.join(" ")} failed: ${error ?? r.stderr}`);
  return { status: r.status, events: lines.filter((l) => "level" in l) as { level: string; label: string; detail?: string }[], result, error };
}

export function sourceEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

/** Extracts a package next to it, for assertions on its content. */
export function unpackForTest(tgz: string) {
  const dir = fs.mkdtempSync(path.join(path.dirname(tgz), "x-"));
  sh("tar", ["xzf", tgz, "-C", dir]);
  return path.join(dir, fs.readdirSync(dir)[0]);
}

/** Snapshot of every file under the given roots (plus git's info/exclude), to prove uninstall leaves no trace. */
export function snapshot(...roots: string[]) {
  const out: Record<string, string> = {};
  for (const root of roots) {
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.name === ".git") {
          const exc = path.join(p, "info", "exclude");
          if (fs.existsSync(exc)) out[exc] = fs.readFileSync(exc, "utf8");
          continue;
        }
        if (e.isDirectory()) walk(p);
        else out[p] = fs.readFileSync(p, "utf8");
      }
    };
    walk(root);
  }
  return out;
}

export const changedSince = (before: Record<string, string>, after: Record<string, string>, ignore: (k: string) => boolean = () => false) =>
  Object.keys({ ...before, ...after }).filter((k) => !k.includes(`${path.sep}ccpack${path.sep}`) && !ignore(k) && before[k] !== after[k]);
