import { spawn } from "node:child_process";
import path from "node:path";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import React, { useEffect, useState } from "react";
import type { Connections } from "../core/connect.js";
import type { inspect } from "../core/install.js";
import type { Mode } from "../core/journal.js";
import { Event, parseLine } from "../protocol.js";
import { DIM, Header, Hint, Mood, ORANGE, Pak, StepLog } from "./theme.js";

type Inspection = ReturnType<typeof inspect>;

/** Runs `ccpack <args> --json` as a child process (see protocol.ts) and streams its lines. */
function useChild<R>(args: string[] | null, env?: Record<string, string>) {
  const [events, setEvents] = useState<Event[]>([]);
  const [result, setResult] = useState<R | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!args) return;
    setEvents([]), setResult(null), setError(null), setDone(false);
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...args, "--json"], { env: { ...process.env, ...env } });
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const l of lines) {
        const m = parseLine(l);
        if (!m) continue;
        if ("result" in m) setResult(m.result as R);
        else if ("error" in m) setError(m.error);
        else setEvents((e) => [...e, m]);
      }
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      if (code) setError((e) => e ?? (err.trim() || `exit ${code}`));
      setDone(true);
    });
  }, [args?.join("\0")]);
  return { events, result, error, done };
}

type Screen =
  | { s: "home" }
  | { s: "pack"; project: string }
  | { s: "pack-run"; project: string; include: string[] }
  | { s: "ask-package"; project: string }
  | { s: "install"; pkg: string; project: string; mode?: Mode }
  | { s: "connect"; project: string }
  | { s: "verify"; project: string; live: boolean }
  | { s: "uninstall"; project: string };
export type { Screen };

const EXEC_LABEL: Record<string, string> = {
  hooks: "Hooks and hook scripts",
  marketplaces: "Plugins from local marketplaces (bundled)",
  env: "Env vars beyond Claude Code switches",
  commands: "statusLine and apiKeyHelper commands",
};

/** Checkboxes: ↑↓ move, space toggles, enter confirms. Everything starts unchecked. */
function Toggles({ items, onDone, hint }: { items: { value: string; label: string; detail?: string[] }[]; onDone: (picked: string[]) => void; hint: string }) {
  const [at, setAt] = useState(0);
  const [on, setOn] = useState<Set<string>>(new Set());
  useInput((input, key) => {
    if (key.upArrow) setAt((a) => Math.max(0, a - 1));
    if (key.downArrow) setAt((a) => Math.min(items.length - 1, a + 1));
    if (input === " ") setOn((s) => (s.has(items[at].value) ? new Set([...s].filter((x) => x !== items[at].value)) : new Set([...s, items[at].value])));
    if (key.return) onDone([...on]);
  });
  return (
    <Box flexDirection="column">
      {items.map((it, i) => (
        <Box key={it.value} flexDirection="column">
          <Text>
            <Text color={ORANGE}>{i === at ? "❯ " : "  "}</Text>
            <Text color={on.has(it.value) ? "yellow" : undefined}>{on.has(it.value) ? "◉" : "○"} {it.label}</Text>
          </Text>
          {it.detail?.map((d) => (
            <Text key={d} color={DIM} wrap="truncate-end">      {d}</Text>
          ))}
        </Box>
      ))}
      <Hint>{hint}</Hint>
    </Box>
  );
}

function Choice({ items, onSelect }: { items: { label: string; value: string }[]; onSelect: (v: string) => void }) {
  return (
    <SelectInput
      indicatorComponent={({ isSelected }) => <Text color={ORANGE}>{isSelected ? "❯ " : "  "}</Text>}
      items={items}
      onSelect={({ value }) => onSelect(value)}
    />
  );
}

export default function App({ initial }: { initial: Screen }) {
  const [screen, setScreen] = useState<Screen>(initial);
  const { exit } = useApp();
  const back = () => (initial.s === "home" ? setScreen({ s: "home" }) : exit());
  const cwd = process.cwd();
  switch (screen.s) {
    case "home":
      return (
        <Box flexDirection="column">
          <Header subtitle={cwd} />
          <Pak say="What are we shipping today?" />
          <Box marginTop={1}>
            <Choice
              items={[
                { label: "Pack this project", value: "pack" },
                { label: "Install a package here", value: "install" },
                { label: "Connect services (keys, OAuth)", value: "connect" },
                { label: "Verify", value: "verify" },
                { label: "Verify live (one claude -p call)", value: "live" },
                { label: "Uninstall", value: "uninstall" },
                { label: "Quit", value: "quit" },
              ]}
              onSelect={(v) => {
                if (v === "quit") return exit();
                if (v === "install") return setScreen({ s: "ask-package", project: cwd });
                if (v === "live" || v === "verify") return setScreen({ s: "verify", project: cwd, live: v === "live" });
                setScreen({ s: v, project: cwd } as Screen);
              }}
            />
          </Box>
        </Box>
      );
    case "pack":
      return <Pack project={screen.project} onBack={back} />;
    case "pack-run":
      return <AppRun screen={screen} onBack={back} />;
    case "ask-package":
      return <AskPackage onDone={(pkg) => setScreen({ s: "install", pkg, project: screen.project })} />;
    case "install":
      return <Install {...screen} onConnect={() => setScreen({ s: "connect", project: screen.project })} onBack={back} />;
    case "connect":
      return <Connect project={screen.project} onBack={back} />;
    case "verify":
      return <Run title="Verify" args={["verify", screen.project, ...(screen.live ? ["--live"] : [])]} onBack={back} />;
    case "uninstall":
      return <Uninstall project={screen.project} onBack={back} />;
  }
}

function moodOf(done: boolean, error: string | null, events: Event[]): Mood {
  if (!done) return "busy";
  return error || events.some((e) => e.level === "fail") ? "error" : "done";
}

/** What Pak says when something failed: the step and the first failure. */
function failureSay(error: string | null, events: Event[]) {
  if (error) return error.split("\n")[0];
  const i = events.findIndex((e) => e.level === "fail");
  const step = events.slice(0, i).reverse().find((e) => e.level === "step");
  return `${step ? `${step.label}: ` : ""}${events[i].label} — see above.`;
}

function useKeyToLeave(active: boolean, onBack: () => void) {
  useInput((_, key) => active && (key.return || key.escape) && onBack(), { isActive: active });
}

function Run<R>({ title, args, onBack, env, say }: { title: string; args: string[]; onBack: () => void; env?: Record<string, string>; say?: (r: R) => string }) {
  const { events, result, error, done } = useChild<R>(args, env);
  useKeyToLeave(done, onBack);
  const mood = moodOf(done, error, events);
  return (
    <Box flexDirection="column">
      <Header subtitle={title} />
      <StepLog events={events} running={!done} />
      {done && (
        <Box marginTop={1} flexDirection="column">
          <Pak mood={mood} say={mood === "error" ? failureSay(error, events) : say && result ? say(result) : "All good."} />
          <Hint>enter to continue</Hint>
        </Box>
      )}
    </Box>
  );
}

function Pack({ project, onBack }: { project: string; onBack: () => void }) {
  const [include, setInclude] = useState<string[] | null>(null);
  if (include) return <AppRun screen={{ s: "pack-run", project, include }} onBack={onBack} />;
  return (
    <Box flexDirection="column">
      <Header subtitle={`Packing ${path.basename(project)}`} />
      <Pak say="Instructions, skills, memory, settings, plugins and MCP go in. Anything that runs code stays out unless you tick it — and your teammate decides again." />
      <Box marginTop={1}>
        <Toggles
          items={Object.entries(EXEC_LABEL).map(([value, label]) => ({ value, label }))}
          onDone={setInclude}
          hint="space to tick · enter to pack · secrets never travel either way"
        />
      </Box>
    </Box>
  );
}

/** Renders the pack-run screen of App (keeps App's switch the single place screens are drawn). */
function AppRun({ screen, onBack }: { screen: Extract<Screen, { s: "pack-run" }>; onBack: () => void }) {
  return (
    <Run
      title={`Packing ${path.basename(screen.project)}`}
      args={["pack", screen.project, ...(screen.include.length ? ["--include", screen.include.join(",")] : [])]}
      onBack={onBack}
      say={(r: { tgz: string; size: number }) => `Sealed: ${r.tgz} (${Math.round(r.size / 1024)} KB). They run: npx ccpack install ${path.basename(r.tgz)}`}
    />
  );
}

function AskPackage({ onDone }: { onDone: (p: string) => void }) {
  const [v, setV] = useState("");
  return (
    <Box flexDirection="column">
      <Header subtitle="Install a package" />
      <Pak say="Which parcel? (path to a .ccpack.tar.gz)" />
      <Box marginTop={1}>
        <Text color={ORANGE}>❯ </Text>
        <TextInput value={v} onChange={setV} onSubmit={(x) => x.trim() && onDone(x.trim())} />
      </Box>
    </Box>
  );
}

function Install({ pkg, project, mode: initialMode, onConnect, onBack }: { pkg: string; project: string; mode?: Mode; onConnect: () => void; onBack: () => void }) {
  const [mode, setMode] = useState<Mode | undefined>(initialMode);
  const [confirmed, setConfirmed] = useState(false);
  const [accept, setAccept] = useState<string[] | null>(null);
  const info = useChild<Inspection>(["inspect", pkg, project, "--mode", mode ?? "project"]);
  const i = info.result;
  if (info.error) return <Run title="Install" args={["inspect", pkg]} onBack={onBack} />;
  if (!i)
    return (
      <Box flexDirection="column">
        <Header subtitle="Opening the parcel" />
        <StepLog events={[{ level: "step", label: "Checking the package" }]} running />
      </Box>
    );
  if (!mode)
    return (
      <Box flexDirection="column">
        <Header subtitle={`${i.name} → ${project}`} />
        <Pak say={`Parcel from ${i.source}, sealed ${i.createdAt.slice(0, 10)}. Where should it live?`} />
        <Box marginTop={1}>
          <Choice
            items={[
              { label: "This project only       — your ~/.claude stays untouched", value: "project" },
              { label: "Into my ~/.claude        — instructions, skills, settings for all my projects", value: "user" },
            ]}
            onSelect={(v) => setMode(v as Mode)}
          />
        </Box>
        <Hint>both are reversible with: ccpack uninstall</Hint>
      </Box>
    );
  if (!confirmed) return <Plan i={i} project={project} onYes={() => setConfirmed(true)} onNo={onBack} />;
  if (accept === null && i.exec.length)
    return (
      <Box flexDirection="column">
        <Header subtitle={`${i.name} → ${project} · executable parts`} />
        <Pak say="The sender included parts that run code on your machine. Tick only what you've read and trust." />
        <Box marginTop={1}>
          <Toggles
            items={i.exec.map((e) => ({ value: e.kind, label: EXEC_LABEL[e.kind], detail: e.lines.slice(0, 8) }))}
            onDone={setAccept}
            hint="space to tick · enter to install · unticked parts are skipped (ccpack inspect shows them all)"
          />
        </Box>
      </Box>
    );
  return <InstallRun pkg={pkg} project={project} mode={mode} accept={accept ?? []} onConnect={onConnect} onBack={onBack} />;
}

/** The confirmation screen: where things land, and everything that will run or widen trust. */
function Plan({ i, project, onYes, onNo }: { i: Inspection; project: string; onYes: () => void; onNo: () => void }) {
  const r = i.review;
  const section = (title: string, lines: string[]) =>
    lines.length > 0 && (
      <Box flexDirection="column" key={title}>
        <Text color="yellow">{title}</Text>
        {lines.map((l) => (
          <Text key={l} wrap="truncate-end">  <Text color={DIM}>·</Text> {l}</Text>
        ))}
      </Box>
    );
  return (
    <Box flexDirection="column">
      <Header subtitle={`${i.name} → ${project} · ${i.mode} mode`} />
      {i.layers.map(([k, v]) => (
        <Text key={k}>
          <Text color={ORANGE}>⏺</Text> <Text bold>{k.padEnd(14)}</Text> <Text color={DIM}>{v}</Text>
        </Text>
      ))}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Review — this runs or changes trust on your machine</Text>
        {section("MCP servers (commands Claude will start)", r.mcp.map((m) => `${m.name}${m.needs.length ? ` [needs ${m.needs.join(", ")}]` : ""}: ${m.runs}`))}
        {section("Plugins", r.plugins.map((p) => `${p.id} from ${p.from}`))}
        {section("Permissions", r.permissions)}
        {section("Environment", r.env)}
        {section(`Project files (${r.files.length})`, [
          ...r.files.filter((f) => f.replaces).map((f) => `${f.path}  — replaces yours, backed up`),
          ...r.files.filter((f) => !f.replaces).slice(0, 12).map((f) => f.path),
          ...(r.files.filter((f) => !f.replaces).length > 12 ? [`…and ${r.files.filter((f) => !f.replaces).length - 12} more (ccpack inspect lists them all)`] : []),
        ])}
        {section("Auto mode rules", r.autoMode)}
      </Box>
      {i.warnings.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {i.warnings.map((w) => (
            <Text key={w} color={DIM}>! {w}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Choice items={[{ label: "Install", value: "y" }, { label: "Cancel", value: "n" }]} onSelect={(v) => (v === "y" ? onYes() : onNo())} />
      </Box>
    </Box>
  );
}

function InstallRun({ pkg, project, mode, accept, onConnect, onBack }: { pkg: string; project: string; mode: Mode; accept: string[]; onConnect: () => void; onBack: () => void }) {
  const { events, result, error, done } = useChild<Connections>(["install", pkg, project, "--mode", mode, ...(accept.length ? ["--accept", accept.join(",")] : [])]);
  const needs = !!result && (result.vars.length > 0 || result.connectors.length > 0);
  useKeyToLeave(done, () => (needs ? onConnect() : onBack()));
  const mood = moodOf(done, error, events);
  return (
    <Box flexDirection="column">
      <Header subtitle={`Installing · ${mode} mode`} />
      <StepLog events={events} running={!done} />
      {done && (
        <Box marginTop={1} flexDirection="column">
          <Pak
            mood={mood}
            say={mood === "error" ? `${failureSay(error, events)} Partial changes are recorded: ccpack uninstall reverts them.` : needs ? "Unpacked. Now the keys and logins that can't travel in a parcel." : "Unpacked. Nothing else to connect."}
          />
          <Hint>enter to {needs ? "connect services" : "finish"}</Hint>
        </Box>
      )}
    </Box>
  );
}

function Connect({ project, onBack }: { project: string; onBack: () => void }) {
  const status = useChild<Connections>(["connect", project, "--check"]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [i, setI] = useState(0);
  const [v, setV] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const c = status.result;
  if (status.error) return <Run title="Connect services" args={["connect", project, "--check"]} onBack={onBack} />;
  if (!c)
    return (
      <Box flexDirection="column">
        <Header subtitle="Connect services" />
        <StepLog events={[{ level: "step", label: "Checking MCP servers (claude mcp list)" }]} running />
      </Box>
    );
  if (submitted && !Object.keys(values).length) return <Leave onBack={onBack} say="Nothing stored. Run ccpack connect again when you have the keys." />;
  if (submitted)
    // TODO: pass secrets on the child's stdin rather than its environment
    return <Run title="Connecting" args={["connect", project]} env={{ CCPACK_SECRETS: JSON.stringify(values) }} onBack={onBack} say={() => "Keys stored in your ~/.claude.json, not in the project."} />;
  const asking = i < c.vars.length;
  return (
    <Box flexDirection="column">
      <Header subtitle="Connect services" />
      <Text bold>MCP servers</Text>
      {c.servers.map((s) => {
        const ok = s.health?.toLowerCase().includes("connected");
        const icon = ok ? <Text color="green">✓</Text> : s.configured ? <Text color="yellow">!</Text> : <Text color={DIM}>○</Text>;
        return (
          <Text key={s.name}>
            {"  "}{icon} {s.name.padEnd(22)}
            <Text color={DIM}>
              {s.health ?? "—"}
              {!s.configured ? `  · needs ${s.vars.join(", ")}` : ""}
              {s.health?.toLowerCase().includes("auth") ? "  · run /mcp in Claude to log in" : ""}
            </Text>
          </Text>
        );
      })}
      {c.connectors.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>claude.ai connectors <Text color={DIM}>— enable on claude.ai › Settings › Connectors, with your account</Text></Text>
          {c.connectors.map((x) => (
            <Text key={x}>  <Text color={DIM}>○</Text> {x}</Text>
          ))}
        </Box>
      )}
      {asking ? (
        <Box flexDirection="column" marginTop={1}>
          <Pak say={`${c.vars[i]} — goes to ${c.servers.filter((s) => s.vars.includes(c.vars[i])).map((s) => s.name).join(", ")}. Empty to skip.`} />
          <Box>
            <Text color={ORANGE}>❯ </Text>
            <TextInput
              value={v}
              mask="•"
              onChange={setV}
              onSubmit={(x) => {
                if (x) setValues((o) => ({ ...o, [c.vars[i]]: x }));
                setV("");
                if (i + 1 >= c.vars.length) setSubmitted(true);
                setI(i + 1);
              }}
            />
          </Box>
          <Hint>{i + 1}/{c.vars.length} · stored only in your ~/.claude.json, never in the project</Hint>
        </Box>
      ) : (
        <Leave onBack={onBack} />
      )}
    </Box>
  );
}

function Leave({ onBack, say }: { onBack: () => void; say?: string }) {
  useKeyToLeave(true, onBack);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Pak mood={say ? "sleepy" : "done"} say={say ?? "Nothing left to type. OAuth logins happen on first use (/mcp in Claude)."} />
      <Hint>enter to finish</Hint>
    </Box>
  );
}

function Uninstall({ project, onBack }: { project: string; onBack: () => void }) {
  const [go, setGo] = useState(false);
  if (go) return <Run title="Uninstall" args={["uninstall", project]} onBack={onBack} say={(r: { undone: number }) => `Returned to sender. ${r.undone} changes reverted.`} />;
  return (
    <Box flexDirection="column">
      <Header subtitle={`Uninstall from ${project}`} />
      <Pak mood="sleepy" say="Remove exactly what ccpack installed here? Anything you changed since stays." />
      <Box marginTop={1}>
        <Choice items={[{ label: "Uninstall", value: "y" }, { label: "Cancel", value: "n" }]} onSelect={(v) => (v === "y" ? setGo(true) : onBack())} />
      </Box>
    </Box>
  );
}
