import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopHostActivation } from "../src/main/engine/desktop-host-activation.js";

test("desktop activation queues early URLs until initialization and coalesces repeats", async () => {
  let starts = 0;
  const activation = createDesktopHostActivation({ available: () => true, start: async () => { starts++; }, onError: (error) => assert.fail(String(error)) });
  assert.equal(activation.open("modex-host://connect"), true);
  assert.equal(activation.open("modex-host://connect"), true);
  assert.equal(starts, 0);
  activation.ready();
  assert.equal(starts, 1);
  activation.ready();
  assert.equal(starts, 1);
});

test("desktop activation accepts only its exact payload-free URL", () => {
  let starts = 0;
  const activation = createDesktopHostActivation({ available: () => true, start: async () => { starts++; }, onError: (error) => assert.fail(String(error)) });
  activation.ready();
  for (const url of ["", "https://connect", "modex-host://other", "modex-host://connect/", "modex-host://connect?allow=true", "modex-host://connect#approve", "modex-host://user@connect", "modex-host://connect:80", "modex-host://%63onnect", "MODEX-HOST://connect"]) {
    assert.equal(activation.open(url), false, url);
  }
  assert.equal(starts, 0);
  assert.equal(activation.open("modex-host://connect"), true);
  assert.equal(starts, 1);
});

test("desktop activation ignores unavailable hosts and drops requests disabled before startup", () => {
  let available = false;
  let starts = 0;
  const activation = createDesktopHostActivation({ available: () => available, start: async () => { starts++; }, onError: (error) => assert.fail(String(error)) });
  assert.equal(activation.open("modex-host://connect"), false);
  available = true;
  assert.equal(activation.open("modex-host://connect"), true);
  available = false;
  activation.ready();
  available = true;
  activation.ready();
  assert.equal(starts, 0);
  activation.open("modex-host://connect");
  assert.equal(starts, 1);
  available = false;
  assert.equal(activation.open("modex-host://connect"), false);
  assert.equal(starts, 1);
});

test("desktop activation reports a startup failure and allows a later retry", async () => {
  const failure = new Error("host startup failed");
  const errors: unknown[] = [];
  let starts = 0;
  const activation = createDesktopHostActivation({ available: () => true, start: async () => { if (++starts === 1) throw failure; }, onError: (error) => errors.push(error) });
  activation.ready();
  activation.open("modex-host://connect");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [failure]);
  activation.open("modex-host://connect");
  assert.equal(starts, 2);
});
