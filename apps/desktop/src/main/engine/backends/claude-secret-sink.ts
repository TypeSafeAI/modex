import type { Observation, UnavailableNativeInput } from "../../../shared/conversation-events.js";
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
    // Preserve ordinary short words; a long unfinished credential prefix is still private.
    sink.observe(redact({ ...tail.event, text: tail.text.length >= 9 ? "[redacted]" : tail.text, ...(tail.event.source ? { source: `${tail.event.source}:redaction-tail` } : {}) }));
  };
  return {
    redact,
    finish() { for (const key of pending.keys()) emitTail(key); },
    sink: {
      ...sink,
      observe(event) {
        // A native identity is exact or unavailable; masking must never create another identity.
        if (contains(event.native) || (event.source && event.source.includes(secret))) return;
        // Redaction changes display text, not the identity of the file the native tool used.
        // Preserve static unavailable-field receipts before discarding the original value.
        const args = event.type === "tool.start" ? event.tool.args : event.type === "tool.update" || event.type === "tool.done" ? event.progress?.args : undefined;
        if (args) {
          const unavailable: UnavailableNativeInput[] = [];
          for (const field of ["file_path", "notebook_path", "path"] as const) if (typeof args[field] === "string" && args[field].includes(secret)) unavailable.push(`args.${field}`);
          if (contains(args)) {
            if (event.type === "tool.start") event = { ...event, tool: { ...event.tool, displayOnlyInputs: true, ...(unavailable.length ? { unavailableInputs: [...new Set([...(event.tool.unavailableInputs ?? []), ...unavailable])] } : {}) } };
            else if (event.type === "tool.update" || event.type === "tool.done") event = { ...event, progress: { ...event.progress, displayOnlyInputs: true, ...(unavailable.length ? { unavailableInputs: [...new Set([...(event.progress?.unavailableInputs ?? []), ...unavailable])] } : {}) } };
          }
        }
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
      ...(sink.question ? { question: async (request, withdrawn) => {
        if (!contains(request)) return sink.question!(request, withdrawn);
        if (request.native) denied.add(JSON.stringify(request.native));
        sink.notice("warn", "Claude asked a question containing the gateway credential. Modex withdrew it without displaying the credential.");
        return { withdrawn: "ended" as const };
      } } : {}),
      refusedByRule(request) { return contains(request) ? "The action contains a protected gateway credential." : sink.refusedByRule?.(request); },
      async deliverRequest(native, write) {
        // A local secret refusal has no human request in the broker; only its fixed denial is written.
        if (denied.delete(JSON.stringify(native)) || !sink.deliverRequest) await write();
        else await sink.deliverRequest(native, write);
      },
    },
  };
}
