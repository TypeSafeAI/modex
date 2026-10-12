import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { wrapNativeFeed } from "../scripts/native-update-fault.mjs";

async function fixture(t, mode) {
  const requests = [];
  const server = createServer(wrapNativeFeed((_req, res) => { res.end("original feed"); }, mode, event => requests.push(event)));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
test("native failure injection refuses only the private artifact route while preserving the real feed", async t => {
  const { url, requests } = await fixture(t, "refuse");
  const token = "a".repeat(64);
  for (const route of [`/${token}/feed`, "/update.zip", `/wrong/${token}/update.zip`]) {
    assert.equal(await (await fetch(url + route)).text(), "original feed");
  }
  const response = await fetch(`${url}/${token}/update.zip`);
  assert.equal(response.status, 503);
  assert.deepEqual(requests, [{ event: "native-artifact-request", fault: "refuse" }]);
});
test("interruption injection observes a real artifact request and holds the response without faking native outcomes", async t => {
  const { url, requests } = await fixture(t, "stall");
  const abort = new AbortController();
  const request = fetch(`${url}/${"b".repeat(64)}/update.zip`, { signal: abort.signal });
  let completed = false;
  request.then(() => { completed = true; }, () => { completed = true; });
  for (let n = 0; requests.length === 0 && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(requests, [{ event: "native-artifact-request", fault: "stall" }]);
  assert.equal(completed, false);
  abort.abort();
  await assert.rejects(request, /abort/i);
});
test("unknown native fault modes fail closed before creating a server", () => {
  assert.throws(() => wrapNativeFeed(() => {}, "unknown", () => {}), /fault mode/);
});
