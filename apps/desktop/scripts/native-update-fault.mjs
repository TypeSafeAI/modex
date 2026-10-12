/** External acceptance driver only. Keep the real Squirrel request and response
 * handling; inject a transport fault without fabricating native updater events. */
export function wrapNativeFeed(listener, mode, record) {
  if (mode !== "refuse" && mode !== "stall") throw new Error("Unknown native fault mode.");
  return function (request, response) {
    if (request.socket.localAddress === "127.0.0.1"
      && (request.method === "GET" || request.method === "HEAD")
      && /^\/[a-f0-9]{64}\/update\.zip$/.test(request.url ?? "")) {
      record({ event: "native-artifact-request", fault: mode });
      if (mode === "refuse") {
        response.writeHead(503, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        response.end("Acceptance transport failure");
      }
      return;
    }
    return listener.call(this, request, response);
  };
}
