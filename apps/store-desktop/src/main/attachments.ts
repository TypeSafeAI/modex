// The Store edition has no attachment path to its host yet: the host's request limit is 1 MB,
// `attachments:pick` is local-only there, and this process does not serve `modex-attachment:`.
// So every `attachments:*` request is answered here and never forwarded.
export const STORE_ATTACHMENTS_UNAVAILABLE = "Attachments are not available in the App Store edition yet.";
export const DEMO_ATTACHMENTS_UNAVAILABLE = "Attachments are not available in the offline demo.";

/** Answers an `attachments:*` channel as unavailable, with `message` as the reason. */
export function attachmentsUnavailable(channel: string, message: string): unknown {
  switch (channel) {
    case "attachments:stage":
    case "attachments:pick": return { staged: [], errors: [message] };
    case "attachments:discard": return undefined;
    case "attachments:open": throw new Error(message);
    default: throw new Error("Unknown attachment action.");
  }
}

/** Routes a connected-host request: attachments stay local, everything else goes to `forward`. */
export function connectedInvoke(channel: string, payload: unknown, forward: (channel: string, payload: unknown) => unknown): unknown {
  if (channel.startsWith("attachments:")) return attachmentsUnavailable(channel, STORE_ATTACHMENTS_UNAVAILABLE);
  return forward(channel, payload);
}
