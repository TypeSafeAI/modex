import type { RoutingPolicy, RoutingStatus, RoutingTest } from "./types.js";

export function sameJudgeSettings(a: RoutingPolicy, b: RoutingPolicy): boolean {
  return a.jev_transport === b.jev_transport && a.jev_bin === b.jev_bin && a.jev_model === b.jev_model;
}

/** Compare an explicit test with the effective saved setup, without credentials. */
export function testMatchesJudge(test: RoutingTest, status: RoutingStatus, policy: RoutingPolicy): boolean {
  return test.current !== false && !!test.tested && test.transport === status.transport.kind &&
    test.tested.model === status.model &&
    (policy.jev_transport === "http" || test.tested.executable ===
      (status.transport.kind === "cli" ? status.transport.bin : policy.jev_bin || "jev"));
}
