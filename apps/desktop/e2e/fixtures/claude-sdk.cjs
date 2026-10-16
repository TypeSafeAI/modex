// Minimal CLI-side initialize handshake. Electron tests still use the real Agent SDK.
exports.handleControl = (message) => {
  if (message.type !== "control_request" || message.request?.subtype !== "initialize") return false;
  process.stdout.write(JSON.stringify({ type: "control_response", response: {
    subtype: "success", request_id: message.request_id,
    response: { commands: [], models: [], account: {} },
  } }) + "\n");
  return true;
};
