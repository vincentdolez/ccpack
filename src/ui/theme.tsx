import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import React from "react";
import type { Level } from "../core/util.js";

export const ORANGE = "#D97757";
export const DIM = "gray";

export type Event = { level: Level; label: string; detail?: string };

/** Pak, the ccpack mascot: a parcel with a face. */
const FACES = { idle: "◕ ◕", busy: "◔ ◔", done: "◠ ◠", error: "× ×", sleepy: "– –" } as const;
const MOUTHS = { idle: " ▿ ", busy: " ~ ", done: " ‿ ", error: " ︵", sleepy: " ▿ " } as const;
export type Mood = keyof typeof FACES;

export function Pak({ mood = "idle", say }: { mood?: Mood; say?: string }) {
  return (
    <Box>
      <Box flexDirection="column" marginRight={2} flexShrink={0}>
        <Text color={ORANGE}>╭──┬──╮</Text>
        <Text color={ORANGE}>│ {FACES[mood]} │</Text>
        <Text color={ORANGE}>│ {MOUTHS[mood]} │</Text>
        <Text color={ORANGE}>╰─────╯</Text>
      </Box>
      {say && (
        <Box flexShrink={1} flexDirection="column" justifyContent="center">
          <Text>
            <Text color={DIM}>‹ </Text>
            {say}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function Header({ subtitle }: { subtitle?: string }) {
  return (
    <Box borderStyle="round" borderColor={ORANGE} paddingX={1} flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={ORANGE}>▣</Text> <Text bold>ccpack</Text>
        <Text color={DIM}> — your Claude Code setup, ready to hand over</Text>
      </Text>
      {subtitle && <Text color={DIM}>  {subtitle}</Text>}
    </Box>
  );
}

const ICON: Record<Exclude<Level, "step">, [string, string]> = {
  ok: ["✓", "green"],
  warn: ["!", "yellow"],
  skip: ["–", DIM],
  fail: ["✗", "red"],
  info: ["·", DIM],
};

/** Claude Code-style transcript: ⏺ for each step, ⎿ for its results. */
export function StepLog({ events, running }: { events: Event[]; running: boolean }) {
  const groups: { step: string; items: Event[] }[] = [];
  for (const e of events) {
    if (e.level === "step") groups.push({ step: e.label, items: [] });
    else {
      if (!groups.length) groups.push({ step: "", items: [] });
      groups[groups.length - 1].items.push(e);
    }
  }
  return (
    <Box flexDirection="column">
      {groups.map((g, i) => {
        const active = running && i === groups.length - 1;
        const failed = g.items.some((x) => x.level === "fail");
        return (
          <Box key={i} flexDirection="column">
            {g.step && (
              <Text>
                {active ? <Text color={ORANGE}><Spinner type="dots" /></Text> : <Text color={failed ? "red" : ORANGE}>⏺</Text>}{" "}
                <Text bold>{g.step}</Text>
              </Text>
            )}
            {g.items.map((x, k) => {
              const [icon, color] = ICON[x.level as Exclude<Level, "step">];
              return (
                <Text key={k}>
                  <Text color={DIM}>{k === 0 ? "  ⎿  " : "     "}</Text>
                  <Text color={color}>{icon}</Text> {x.label}
                  {x.detail ? <Text color={DIM}>  {x.detail}</Text> : null}
                </Text>
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return (
    <Box marginTop={1}>
      <Text color={DIM}>{children}</Text>
    </Box>
  );
}
