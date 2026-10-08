# Security

## Reporting

Please report vulnerabilities privately through GitHub's **Report a vulnerability** (Security tab). Don't open a public issue.

> [!WARNING]
> Install packages only from people you trust. Version 0.1.0 has known receiver-side issues with hand-crafted packages, listed in the README's TODO section: prototype pollution through `__proto__` keys, undeclared `${VAR}` references in MCP configs, and `connect` filling keys into undeclared servers.

## Threat model

| Party | Risk | What ccpack does |
|---|---|---|
| Sender | leaking credentials | credential-like values in MCP configs become `${VAR}`; env vars and rules carrying credentials are dropped; the package is scanned (known formats, plus opaque tokens in its JSON configs) and refused if anything matches |
| Sender | oversharing | instructions, user skills and memory are shared on purpose; `ccpack inspect` shows exactly what's inside before you send it |
| Receiver | malicious package writing outside its targets | archives with links, `..`, absolute paths or unknown files are refused before anything is written; every name used in a path or CLI argument is validated |
| Receiver | code execution and widened trust | settings-level executables (hooks and hook scripts, bundled local-marketplace plugins, env vars beyond Claude Code switches, `statusLine`/`apiKeyHelper`) are installed only when the receiver accepts them by kind; outside `exec.json` they are refused; MCP configs must be plain stdio or http/sse shapes; the interactive install screen and `inspect` list MCP commands, URLs, env and header names, plugin sources, permission rules, env vars, project files and `command` hooks first. **Not covered:** skills, agents and commands can run code (`allowed-tools`, `` !`cmd` ``, frontmatter hooks); MCP servers without keys start in the next session; `--yes` skips the review; plugins from git marketplaces may ship hooks |
| Receiver | keys sent to the wrong place | `connect` never reads the environment implicitly, removes keys from its environment before starting any process, and writes them only to `~/.claude.json`; the journal stores hashes, not values. **Known issue:** a typed value is filled into every server that references it, declared or not |
| Receiver | losing their own config | their values win on conflicts; same-name MCP servers are never merged into; files are backed up; uninstall reverts only what ccpack changed and keeps whatever changed after install |

The secret scan matches known formats (Google, Anthropic, OpenAI, Stripe, GitHub, GitLab, Slack, AWS, Hugging Face, npm, JWT, private keys, credentials in URLs, bearer tokens) everywhere, and opaque token-shaped values in the package's JSON configs. It cannot catch everything. For example, a password written in plain prose inside a memory file won't match. Review your package with `ccpack inspect`.
