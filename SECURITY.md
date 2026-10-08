# Security

## Reporting

Please report vulnerabilities privately through GitHub's **Report a vulnerability** (Security tab). Don't open a public issue.

## Threat model

| Party | Risk | What ccpack does |
|---|---|---|
| Sender | leaking credentials | credential-like values in MCP configs become `${VAR}`; env vars and rules carrying credentials are dropped; the package is scanned (known formats, plus opaque tokens in its JSON configs) and refused if anything matches |
| Sender | oversharing | instructions, user skills and memory are shared on purpose; `ccpack inspect` shows exactly what's inside before you send it |
| Receiver | malicious package writing outside its targets | archives with links, `..`, absolute paths or unknown files are refused before anything is written; every name used in a path or CLI argument is validated |
| Receiver | code execution and widened trust | executable parts (hooks and hook scripts, bundled local-marketplace plugins, env vars beyond Claude Code switches, `statusLine`/`apiKeyHelper`) are installed only when the receiver accepts them by kind, after seeing every command; outside `exec.json` they are refused even from a hand-crafted package; MCP configs must be plain stdio or http/sse shapes; the install screen and `inspect` list every MCP command, URL, env and header name, plugin source, permission rule, env var and project file first; MCP servers are registered once that list is confirmed; writes never follow a link out of the project or the Claude config. Plugins from git marketplaces may ship hooks, as with `claude plugin install` |
| Receiver | keys sent to the wrong place | `connect` never reads the environment implicitly, shows which servers receive each key, removes the keys from its environment before starting any process, and writes them only to `~/.claude.json`; the journal stores hashes, not values |
| Receiver | losing their own config | their values win on conflicts; same-name MCP servers are never merged into; files are backed up; uninstall reverts only what ccpack changed and keeps whatever changed after install |

The secret scan matches known formats (Google, Anthropic, OpenAI, Stripe, GitHub, GitLab, Slack, AWS, Hugging Face, npm, JWT, private keys, credentials in URLs, bearer tokens) everywhere, and opaque token-shaped values in the package's JSON configs. It cannot catch everything. For example, a password written in plain prose inside a memory file won't match. Review your package with `ccpack inspect`.
