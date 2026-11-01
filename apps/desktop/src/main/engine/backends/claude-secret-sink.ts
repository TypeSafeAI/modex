import type { Observation } from "../../../shared/conversation-events.js";
import type { TurnSink } from "./types.js";

type Delta = Extract<Observation, { type: "message.delta" | "reasoning.delta" }>;

/** Redact before observations enter the journal or IPC, retaining only a possible key prefix per stream. */
export function claudeSecretSink(sink: TurnSink, secret: string): { sink: TurnSink; finish(): void; redact<T>(value: T): T } {
  const redactText = (text: string) => text.split(secret).join("[redacted]");
  const redact = <T>(value: T): T => JSON.parse(redactText(JSON.stringify(value))) as T;
  const contains = (value: unknown) => JSON.stringify(value).includes(secret);
  const pending = new Map<string, { event: Delta; text: string }>();
  const denied = new Set<string>();
  const nativeKey = (o: Observation) => JSON.stringify(o.native);
  const emitTail = (key: string) => {
    const tail = pending.get(key);
    if (!tail) return;
    pending.delete(key);
    // The stream is closed: a proper prefix cannot complete a key, so preserve ordinary text.
    sink.observe(redact({ ...tail.event, text: tail.text, ...(tail.event.source ? { source: `${tail.event.source}:redaction-tail` } : {}) }));
  };
  return {
    redact,
    finish() { for (const key of pending.keys()) emitTail(key); },
    sink: {
      ...sink,
      observe(event) {
        if (event.type === "message.delta" || event.type === "reasoning.delta") {
          const key = `${nativeKey(event)}:${event.type}:${event.type === "reasoning.delta" ? `${event.representation}:${event.index}` : ""}`;
          const text = redactText((pending.get(key)?.text ?? "") + event.text);
          let length = Math.min(secret.length - 1, text.length);
          while (length > 0 && !text.endsWith(secret.slice(0, length))) length--;
          if (length) pending.set(key, { event, text: text.slice(-length) }); else pending.delete(key);
          const safe = length ? text.slice(0, -length) : text;
          if (safe) sink.observe(redact({ ...event, text: safe }));
          return;
        }
        if (event.type === "message.done" || event.type === "reasoning.done") {
          for (const key of pending.keys()) if (key.startsWith(`${nativeKey(event)}:`)) emitTail(key);
        }
        sink.observe(redact(event));
      },
      notice(level, text) { sink.notice(level, redactText(text)); },
      session(handle) {
        if (handle.includes(secret)) sink.notice("warn", "Claude returned a credential in its session identifier; that identifier was not saved.");
        else sink.session(handle);
      },
      async approval(request, withdrawn) {
        if (!contains(request)) return sink.approval(request, withdrawn);
        // Do not display a redacted command and then approve the different raw command.
        if (request.native) denied.add(JSON.stringify(request.native));
        sink.notice("warn", "Claude requested an action containing the gateway credential. Modex denied it without displaying the credential.");
        return "no";
      },
      refusedByRule(request) { return contains(request) ? "The action contains a protected gateway credential." : sink.refusedByRule?.(request); },
      async deliverRequest(native, write) {
        // A local secret refusal has no human request in the broker; only its fixed denial is written.
        if (denied.delete(JSON.stringify(native)) || !sink.deliverRequest) await write();
        else await sink.deliverRequest(native, write);
      },
    },
  };
}
