import type { TurnSink } from "../backends/types.js";

export const TOKEN_MASK = "[local token]";

/** How much of the end of `text` could still grow into `token`. */
function heldBack(text: string, token: string): number {
  for (let length = Math.min(token.length - 1, text.length); length > 0; length--) {
    if (text.endsWith(token.slice(0, length))) return length;
  }
  return 0;
}

/**
 * CodexBackend redacts each line it reads, but a streamed token can cross two lines. This holds back the end of each
 * stream while it could still become the token, so no renderer event or tool log ever holds it or part of its start.
 * Whatever is held when an item ends unexpectedly is dropped: at most a piece of text that looked like the token's start.
 */
export function redactingSink(sink: TurnSink, token: string | null): TurnSink {
  if (!token) return sink;
  const streams = new Map<string, string>();
  const push = (key: string, delta: string): string => {
    const text = ((streams.get(key) ?? "") + delta).split(token).join(TOKEN_MASK);
    const held = heldBack(text, token);
    streams.set(key, text.slice(text.length - held));
    return text.slice(0, text.length - held);
  };
  const end = (key: string): string => { const rest = streams.get(key) ?? ""; streams.delete(key); return rest; };
  return {
    ...sink,
    ...(sink.output ? { output: (native, chunk) => { const text = push(`output:${native.item}`, chunk); if (text) sink.output!(native, text); } } : {}),
    observe(observation) {
      switch (observation.type) {
        case "message.delta": {
          const text = push(`message:${observation.native.item}`, observation.text);
          if (text) sink.observe({ ...observation, text });
          return;
        }
        case "reasoning.delta": {
          const text = push(`reasoning:${observation.native.item}:${observation.representation}:${observation.index}`, observation.text);
          if (text) sink.observe({ ...observation, text });
          return;
        }
        case "message.done": {
          const rest = end(`message:${observation.native.item}`);
          if (rest) sink.observe({ type: "message.delta", native: observation.native, text: rest });
          break;
        }
        case "reasoning.done":
          for (const key of [...streams.keys()]) {
            if (!key.startsWith(`reasoning:${observation.native.item}:`)) continue;
            const [, , representation, index] = key.split(":") as [string, string, "summary" | "provider-text", string];
            const rest = end(key);
            if (rest) sink.observe({ type: "reasoning.delta", native: observation.native, representation, index: Number(index), text: rest });
          }
          break;
        case "tool.update": {
          // The whole output so far, rebuilt from deltas after CodexBackend's per-line redaction.
          const output = observation.progress.output;
          if (output !== undefined) {
            const text = output.split(token).join(TOKEN_MASK);
            sink.observe({ ...observation, progress: { ...observation.progress, output: text.slice(0, text.length - heldBack(text, token)) } });
            return;
          }
          break;
        }
        case "tool.done": {
          const rest = end(`output:${observation.native.item}`);
          if (rest) sink.output?.(observation.native, rest);
          const output = observation.progress?.output;
          if (output !== undefined) {
            sink.observe({ ...observation, progress: { ...observation.progress, output: output.split(token).join(TOKEN_MASK) } });
            return;
          }
          break;
        }
      }
      sink.observe(observation);
    },
  };
}
