/**
 * Everything that decides what may leave the sender's machine — and what a package may set on
 * the receiver's. Allow-lists, not block-lists: a value travels only when it can't be a credential
 * and can't make anything run.
 */
import fs from "node:fs";
import path from "node:path";
import { home, isObj, Json, JsonObj, listFiles } from "./util.js";

const PATTERNS: [string, RegExp][] = [
  ["Google OAuth secret", /GOCSPX-[\w-]{10,}/],
  ["Google API key", /AIza[\w-]{30,}/],
  ["Anthropic key", /sk-ant-[\w-]{20,}/],
  ["OpenAI key", /sk-(proj-)?[A-Za-z0-9_-]{32,}/],
  ["Stripe key", /[sr]k_(live|test)_[A-Za-z0-9]{16,}/],
  ["GitHub token", /(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{40,})/],
  ["GitLab token", /glpat-[\w-]{20,}/],
  ["Slack token", /xox[abprs]-\d+-[\w-]{10,}/],
  ["Slack webhook", /hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["Hugging Face token", /hf_[A-Za-z0-9]{30,}/],
  ["npm token", /npm_[A-Za-z0-9]{36}/],
  ["JWT", /eyJ[\w-]{20,}\.[\w-]{20,}\.[\w-]+/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["credentials in URL", /[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'$]+:[^\s/@"'$]+@/i],
  ["bearer token", /bearer\s+[A-Za-z0-9._~+/-]{16,}=*/i],
];
const PLACEHOLDER = /your|example|xxxx|placeholder|dummy|redacted|changeme|demo|sample|abc123|\.{3}|<[^>]+>/i;

/** Env/config key names that hold credentials — whole words only (PATH, AUTHOR, BYPASS are fine). */
export const SECRET_KEY = /(^|_)(KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|AUTH|COOKIE|SESSION|PAT|PRIVATE|SIGNATURE)(_|$)/i;

/**
 * The only env vars a package may set on the receiver: Claude Code switches with short plain values.
 * Anything else (BASH_ENV, *_PROXY, OTEL_*, PATH, NODE_OPTIONS, ANTHROPIC_*…) can run code or move
 * traffic, so it is shown, never installed.
 */
const ENV_ALLOW = /^(CLAUDE_CODE_(EXPERIMENTAL_[A-Z0-9_]+|DISABLE_[A-Z0-9_]+|MAX_OUTPUT_TOKENS)|MAX_THINKING_TOKENS|MAX_MCP_OUTPUT_TOKENS|MCP_TIMEOUT|MCP_TOOL_TIMEOUT|BASH_DEFAULT_TIMEOUT_MS|BASH_MAX_TIMEOUT_MS|BASH_MAX_OUTPUT_LENGTH|DISABLE_[A-Z0-9_]+)$/;
const PLAIN_VALUE = /^[\w.-]{0,32}$/;

/** Names of the secret patterns found in a text (placeholders ignored). */
export function findSecrets(txt: string): string[] {
  return PATTERNS.filter(([, re]) => {
    const m = txt.match(new RegExp(re.source, re.flags + "g"));
    return m?.some((x) => !PLACEHOLDER.test(x));
  }).map(([n]) => n);
}

const NOT_TOKENS = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^[0-9a-f]{40}$/i, // git commit
  /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/, // UPPER_SNAKE identifier (a variable name)
  /(==|@)?v?\d+\.\d+(\.\d+)?([.-][\w.]+)?$/, // ends with a version
];
/** Opaque value that could be a token: long, no spaces, letters and digits, not a known harmless shape. */
export const tokenShaped = (v: string) =>
  v.length >= 20 && /^[A-Za-z0-9_\-+/=.]+$/.test(v) && /[A-Za-z]/.test(v) && /\d/.test(v) &&
  (!v.includes("/") || (v.length >= 32 && !v.startsWith("/") && !/\.\w{1,5}$/.test(v))) &&
  !NOT_TOKENS.some((re) => re.test(v));
const looksSecret = (v: string) => (tokenShaped(v) || findSecrets(v).length > 0) && !v.includes("${");
/** Also looks inside: KEY=value pairs, words, and URLs. */
const containsSecret = (v: string) =>
  looksSecret(v) || v.split(/[\s'"()&;|,]+/).some((w) => looksSecret(w.replace(/^[\w-]+[=:]/, "")) || (w.includes("://") && urlHasSecret(w)));

export const PORTABLE_SETTINGS = [
  "env", "language", "effortLevel", "model", "outputStyle", "includeCoAuthoredBy", "attribution",
  "permissions", "autoMode", "alwaysThinkingEnabled", "claudeMdExcludes",
];

/** Settings keys that run commands: they travel only as an opt-in executable part. */
const COMMAND_KEYS = ["hooks", "statusLine", "apiKeyHelper"];

/**
 * Splits settings into what travels by default (`clean`: behaviour-shaping, credential-free, runs
 * nothing), what may travel on opt-in (`exec`: hooks, statusLine, apiKeyHelper, other env vars), and
 * what never does (`dropped`, with the reason). Credentials never travel, executable or not.
 */
export function sanitizeSettings(s: JsonObj): { clean: JsonObj; exec: JsonObj; dropped: string[] } {
  const dropped: string[] = [];
  const clean: JsonObj = {};
  const exec: JsonObj = {};
  const h = home();
  const shellHome = (v: Json): Json =>
    typeof v === "string" ? v.split(h + "/").join("$HOME/")
    : Array.isArray(v) ? v.map(shellHome)
    : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shellHome(x)]))
    : v;
  const strings = (v: Json): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : isObj(v) ? Object.values(v).flatMap(strings) : []);
  for (const [k, v] of Object.entries(s)) {
    if (PORTABLE_SETTINGS.includes(k)) clean[k] = JSON.parse(JSON.stringify(v));
    else if (COMMAND_KEYS.includes(k)) {
      if (strings(v).some(containsSecret)) dropped.push(`${k} (contains a credential)`);
      else exec[k] = shellHome(v);
    } else dropped.push(`${k} (not portable)`);
  }
  if (isObj(clean.env)) {
    const extra: JsonObj = {};
    for (const [k, v] of Object.entries(clean.env)) {
      if (ENV_ALLOW.test(k) && typeof v === "string" && PLAIN_VALUE.test(v)) continue;
      delete clean.env[k];
      if (SECRET_KEY.test(k) || typeof v !== "string" || containsSecret(v)) dropped.push(`env.${k} (credential)`);
      else extra[k] = v === h || v.startsWith(h + "/") ? v.replace(h, "${HOME}") : v;
    }
    if (!Object.keys(clean.env).length) delete clean.env;
    if (Object.keys(extra).length) exec.env = extra;
  } else delete clean.env;
  if (isObj(clean.permissions)) {
    const p = clean.permissions;
    if (p.defaultMode === "bypassPermissions") (delete p.defaultMode, dropped.push("permissions.defaultMode (bypassPermissions)"));
    for (const list of ["allow", "ask", "deny"])
      if (Array.isArray(p[list]))
        p[list] = (p[list] as Json[]).filter((r) => {
          const bad = typeof r !== "string" || containsSecret(r.replace(/^\w+\(|\)$/g, ""));
          if (bad) dropped.push(`permissions.${list} rule containing a credential`);
          return !bad;
        });
  }
  return { clean, exec, dropped };
}

/** UPPER_SNAKE variable name, never starting with a digit. */
export const varName = (...parts: string[]) => {
  const v = parts.join("_").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").toUpperCase();
  return /^[A-Z]/.test(v) ? v : `V_${v}`;
};

function urlHasSecret(raw: string) {
  try {
    const u = new URL(raw);
    const open = (x: string) => !!x && !/\$\{|%7B/i.test(x); // a ${VAR} part is already templated
    return open(u.username) || open(u.password) || (u.hash.length > 8 && open(u.hash)) ||
      [...u.searchParams.values()].some((v) => v.length >= 12 && open(v)) ||
      u.pathname.split("/").some((seg) => open(seg) && looksSecret(safeDecode(seg)));
  } catch {
    return looksSecret(raw);
  }
}
const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * A URL with every credential-bearing part replaced by ${VAR}: userinfo, query values that aren't
 * short plain words, the fragment, and token-shaped path segments. Already-templated URLs are kept.
 */
function templateUrl(raw: string, as: (v: string) => string, prefix: string): string {
  if (raw.includes("${")) return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return looksSecret(raw) ? as(varName(prefix, "URL")) : raw;
  }
  const marks: [string, string][] = [];
  const mark = (v: string) => (marks.push([`CCPACKMARK${marks.length}X`, as(v)]), marks[marks.length - 1][0]);
  const creds = !!(u.username || u.password);
  u.username = u.password = "";
  for (const [k, v] of [...u.searchParams]) if (v.length >= 12 || /(key|token|secret|password|auth|sig|code)/i.test(k)) u.searchParams.set(k, mark(varName(prefix, k)));
  u.pathname = u.pathname.split("/").map((seg, i) => (looksSecret(safeDecode(seg)) ? mark(varName(prefix, "URL", "PATH", String(i))) : seg)).join("/");
  if (u.hash.length > 1) u.hash = mark(varName(prefix, "URL", "FRAGMENT"));
  let s = u.toString();
  if (!/^[a-z][\w+.-]*:\/\/[^/?#]*\//i.test(raw) && s.endsWith("/") && u.pathname === "/") s = s.slice(0, -1); // no trailing "/" added
  for (const [m, v] of marks) s = s.replace(m, v);
  return creds ? s.replace("://", `://${as(varName(prefix, "URL", "CREDENTIALS"))}@`) : s;
}

const SECRET_FLAG = /^(-H|--?(?:[\w-]*[-_])?(key|apikey|api-key|token|secret|password|passwd|pat|auth|header|cookie|credentials?|bearer))$/i;

/**
 * MCP config → copy where every credential is a ${VAR}, plus the vars introduced.
 * Env vars keep their own name when they can (several servers may share one key).
 */
export function templatizeMcp(name: string, cfg: JsonObj): { config: JsonObj; vars: string[] } {
  const vars = new Set<string>();
  const h = home();
  const homeify = (v: string) => (v === h ? "${HOME}" : v.split(h + "/").join("${HOME}/"));
  const as = (v: string) => (vars.add(v), "${" + v + "}");
  const value = (v: string, varFor: () => string, prefix: string) =>
    v === h || v.startsWith(h + "/") ? homeify(v) // a path under home is a location, not a credential
    : v.includes("://") ? templateUrl(v, as, prefix)
    : looksSecret(v) ? as(varFor())
    : v;
  const out: JsonObj = {};
  for (const k of ["type", "command"] as const) if (typeof cfg[k] === "string") out[k] = homeify(cfg[k] as string);
  if (typeof cfg.url === "string" && !out.type) out.type = "http"; // Claude Code's default for a url
  if (Array.isArray(cfg.args)) {
    const args = cfg.args.filter((a): a is string => typeof a === "string");
    out.args = args.map((a, i) => {
      const prev = i > 0 ? args[i - 1] : "";
      const flag = a.match(/^(--?[\w-]+)=(.*)$/s);
      if (flag && SECRET_FLAG.test(flag[1])) return `${flag[1]}=${as(varName(name, flag[1]))}`;
      if (SECRET_FLAG.test(prev)) {
        const header = a.match(/^([\w-]+):\s*(.*)$/s); // -H "X-Api-Key: …" keeps the header name
        return header ? `${header[1]}: ${as(varName(name, header[1]))}` : as(varName(name, prev));
      }
      return value(a, () => varName(name, "ARG", String(i + 1)), name);
    });
  }
  if (typeof cfg.url === "string") out.url = templateUrl(cfg.url, as, name);
  if (isObj(cfg.env)) {
    const env: JsonObj = {};
    for (const [k, v] of Object.entries(cfg.env)) {
      if (typeof v !== "string") continue;
      const own = /^[A-Z][A-Z0-9_]*$/.test(k) ? k : varName(name, k);
      const isPath = v === h || v.startsWith(h + "/");
      env[k] = !isPath && (SECRET_KEY.test(k) || k.includes("CLIENT_ID")) ? as(own) : value(v, () => own, `${name}_${k}`);
    }
    out.env = env;
  }
  if (isObj(cfg.headers)) {
    const headers: JsonObj = {};
    for (const k of Object.keys(cfg.headers)) headers[k] = as(varName(name, k));
    out.headers = headers;
  }
  return { config: out, vars: [...vars] };
}

/** Fills ${VAR} references (HOME included) in every string of an MCP config. */
export function fillVars(cfg: JsonObj, values: Record<string, string>): JsonObj {
  const fill = (v: Json): Json =>
    typeof v === "string"
      ? v.replace(/\$\{(\w+)\}/g, (m, k) => (k === "HOME" ? home() : k in values ? values[k] : m))
      : Array.isArray(v) ? v.map(fill)
      : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
      : v;
  return fill(cfg) as JsonObj;
}

/**
 * Secret-looking values anywhere in a package: known formats everywhere, opaque tokens in its JSON configs.
 * TODO: prose secrets in memory/instructions (a password in a sentence) are not detected.
 */
export function scanSecrets(dir: string): string[] {
  const hits: string[] = [];
  for (const rel of listFiles(dir)) {
    const buf = fs.readFileSync(path.join(dir, rel));
    if (buf.includes(0)) continue;
    const txt = buf.toString("utf8");
    for (const n of findSecrets(txt)) hits.push(`${rel}: ${n}`);
    if (!rel.includes(path.sep) && rel.endsWith(".json") && rel !== "manifest.json") {
      const strings: string[] = [];
      const walk = (v: unknown) => (typeof v === "string" ? strings.push(v) : Array.isArray(v) ? v.forEach(walk) : isObj(v) && Object.values(v).forEach(walk));
      walk(JSON.parse(txt));
      if (strings.some((s) => containsSecret(s))) hits.push(`${rel}: opaque token`);
    }
  }
  return hits;
}
