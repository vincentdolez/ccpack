# Package format — v1

A package is a gzipped tarball holding one folder, `<name>.ccpack/`. Readers must refuse:

- links of any kind;
- absolute paths and `..`;
- files outside the paths listed below;
- a `format` newer than they support.

`src/core/format.ts` is the reference implementation.

| Path | Content | Project mode → | User mode → |
|---|---|---|---|
| `manifest.json` | see below | — | — |
| `instructions.md` | user `CLAUDE.md`, user rules, parent-directory `CLAUDE.md`, in load order, each preceded by `<!-- source: … -->` | marked block in `CLAUDE.local.md` | marked block in `~/.claude/CLAUDE.md` |
| `skills/<name>/…`, `agents/<name>.md`, `commands/<name>.md`, `output-styles/<name>.md` | user-level items, symlinks dereferenced | `<project>/.claude/…` | `~/.claude/…` |
| `files/<path>` | project files git doesn't carry; `<path>` is `.claude/{skills,agents,commands,output-styles,rules}/…`, any `CLAUDE.md` (nested ones included) or `AGENTS.md` — never settings or hook scripts | `<project>/<path>` | `<project>/<path>` |
| `settings.json` | portable keys of the user settings | merged into `.claude/settings.local.json` | merged into `~/.claude/settings.json` |
| `settings.local.json` | portable keys of the project's local settings | merged into `.claude/settings.local.json` | same |
| `mcp.json` | `{ "<server>": { "scope": "user"\|"project"\|"local", "config": {…}, "vars": ["VAR", …] } }` | `~/.claude.json` local scope | user-scope servers at user scope, others local |
| `plugins.json` | `{ "plugins": [{ "id": "name@marketplace", "marketplace": "…", "source": {"kind":"github","repo":"o/r"} \| {"kind":"git","url":"https://…"} \| {"kind":"vendored","dir":"marketplaces/<marketplace>"} }] }` | `claude plugin install --scope local` | `--scope user` |
| `memory/…` | the project's auto-memory | `<config>/projects/<slug>/memory/` | same |
| `exec.json` | opt-in executable settings: `{ "user": {…}, "local": {…} }` with only `hooks` (kind `hooks`), `env` (kind `env`), `statusLine` / `apiKeyHelper` (kind `commands`) | merged into `.claude/settings.local.json`, per accepted kind | user part into `~/.claude/settings.json` |
| `exec-files/project/.claude/hooks/…`, `exec-files/user/hooks/…` | hook scripts (kind `hooks`) | `<project>/.claude/hooks/…`, `<config>/hooks/…` | same |
| `marketplaces/<marketplace>/…` | bundled local marketplaces, plugin source `{"kind":"vendored","dir":"marketplaces/<marketplace>"}` (kind `marketplaces`) | `claude plugin marketplace add` from a copy under `<config>/ccpack/` | same |

Portable settings keys: `env`, `language`, `effortLevel`, `model`, `outputStyle`, `includeCoAuthoredBy`, `attribution`, `permissions`, `autoMode`, `alwaysThinkingEnabled`, `claudeMdExcludes`.

Readers filter both settings files with the same allow-list on arrival, accept `exec.json`, `exec-files/` and `marketplaces/` only for kinds listed in `manifest.exec`, and install each kind only when the receiver accepts it. MCP configs are either `{type?: "stdio", command, args?, env?, headers?}` or `{type: "http"|"sse", url, env?, headers?}`; strings contain no C0 control characters, DEL or U+009B (C1 and bidi controls: TODO). `instructions.md` must not contain `<!-- ccpack:`.

Excluded on the way out:
- `env` entries with secret-like names or values; other env vars beyond Claude Code switches travel only in `exec.json`, with `--include env`;
- `permissions.defaultMode: bypassPermissions`;
- permission rules containing a credential.

In MCP configs, `${VAR}` marks a value the receiver provides; every `${VAR}` must be listed in that server's `vars` (readers refuse the package otherwise). `${HOME}` is the receiver's home directory.

## manifest.json

```jsonc
{
  "format": 1,                     // readers refuse a higher number
  "producer": "ccpack@0.1.0",
  "agent": "claude-code",
  "name": "proj",                  // [A-Za-z0-9._@-]
  "source": "~/work/proj",         // home-relative, informational
  "createdAt": "2026-10-08T…Z",
  "items": [                       // the inventory: what was found, and what was left out
    { "id": "skill:review", "kind": "skill", "name": "review", "origin": "user", "status": "included" },
    { "id": "mcp:db", "kind": "mcp", "name": "db", "origin": "local", "status": "included", "needs": ["DB_URL_CREDENTIALS"] },
    { "id": "connector:Gmail", "kind": "connector", "name": "Gmail", "origin": "account", "status": "excluded", "reason": "…" }
  ],
  "warnings": ["…"],
  "exec": ["hooks"]                // executable kinds included: hooks, marketplaces, env, commands
}
```

`kind`: `instructions` `skill` `agent` `command` `output-style` `file` `settings` `plugin` `mcp` `memory` `connector`.

`origin`: `user` `parent` `project` `local` `account`.

`status`: `included` `excluded` `shadowed`.

`id` is `<kind>:<name>`. It is stable across packs, so tools can join on it.
