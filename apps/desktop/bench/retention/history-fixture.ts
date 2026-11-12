const TURNS = 200;
export function longTranscript(threadId: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const at = new Date(Date.now() - TURNS * 60_000).toISOString();
  for (let turn = 0; turn < TURNS; turn++) {
    const user = `u-${turn}`;
    const origin = (item: string) => ({ thread: threadId, turn: user, attempt: `a-${turn}`, backend: "codex", native: { runtime: "R", thread: "nt", turn: `nu-${turn}`, item } });
    out.push({ id: user, kind: "user", text: `Request ${turn}: tidy the module and run its tests.`, at });
    out.push({ id: `r-${turn}`, kind: "thinking", text: `Plan for ${turn}: ${"read the module, then test it. ".repeat(10)}`, reasoning: "summary", status: "done", outcome: "succeeded", durationMs: 2000, origin: origin(`r-${turn}`), at });
    out.push({ id: `c-${turn}`, kind: "assistant", text: `Looking at module ${turn}. ${"Reading the files first. ".repeat(8)}`, phase: "commentary", nativePhase: "commentary", outcome: "succeeded", origin: origin(`c-${turn}`), at });
    for (let k = 0; k < 3; k++) {
      const id = `t-${turn}-${k}`;
      out.push({ id, kind: "tool", name: "shell", title: `$ npm test -- part ${k}`, args: { command: `npm test -- part ${k}` }, status: "done", ok: true, outcome: "succeeded",
        exec: { command: `/bin/zsh -lc 'npm test -- part ${k}'`, cwd: "/repo" }, exitCode: 0, output: `ok ${turn}.${k}\n`.repeat(400), outputBytes: 4000, durationMs: 1200, origin: origin(id), at });
    }
    out.push({ id: `f-${turn}`, kind: "assistant", text: `Answer ${turn}.\n\n- Tidied module ${turn}.\n- Tests pass.\n\n\`\`\`ts\nexport const value${turn} = ${turn};\n\`\`\`\n${"More detail on the change. ".repeat(20)}`,
      phase: "final", nativePhase: "final_answer", outcome: "succeeded", origin: origin(`f-${turn}`), at });
  }
  return out;
}

