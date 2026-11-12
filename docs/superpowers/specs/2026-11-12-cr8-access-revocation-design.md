# CR-8 accessible-to-revoked integration evidence

The accepted #327 adversarial requirement names revoked access and no secret leakage. Service units already verify 403/404/410 invalidation and an in-flight context read, while existing Electron coverage starts with an inaccessible repository. This slice verifies the missing transition through the existing production renderer, preload, IPC, read service and GitHub CLI transport.

## Contract and approach

An initially visible private PR body and six ready IPC read variants must become unavailable after main observes 403, 404 or 410. A later network failure must never restore that PR's kept overview, resolve result, context, activity, checks or files. A different repository retains its legitimate same-account offline fallback. An already in-flight context response cannot resurrect revoked content. Provider starts and write calls remain zero; raw CLI diagnostics stay outside replies and rendered content.

The executor chooses the existing WORLD_GH dependency boundary, adding an opt-in offline flag that emits a real CLI network failure for API reads while keeping the synthetic identity endpoint available. Defaults remain unchanged. Compared with extending service-unit coverage, this supplies the missing Electron boundary; compared with a live revocation exercise, it is deterministic and needs no personal account or repository permission changes. Neither alternative replaces this accepted fixture requirement. This is verification of existing policy, with no new product policy or activation decision.

## Scope and limits

Only the existing E2E regression file, synthetic gh fixture, this plan/spec and a dated receipt/status entry are intended changes. If a real product defect appears, preserve the first failure and add a demonstrated repair before expanding scope. Do not merge another owner's pending work. No live inference, GitHub mutation, release, default activation, real token or physical/human acceptance is involved. The full #327 criterion stays unchecked until all its clauses and actual protected delivery are independently audited.

The same accepted adversarial clause also requires unsafe-path coverage. A source inventory found URL-path checks and request-validator units but no direct Electron context-path boundary case. Add one valid context positive control followed by literal unsafe requests, proving real IPC refusal with no additional gh calls, provider starts or mutations. This is a verification addition, not a new path policy.

## Verification

Write the integration tests first. Verify the new offline branch initially fails its positive control; implement that fixture capability and rerun. Existing policy may already pass: do not invent a production repair. Run a controlled temporary production mutation classifying 403 as transient offline, verify the 403 integration case fails, restore exact production bytes and verify the clean suite. Preserve every first failure and negative-control output separately. Run fresh build/full units and full repository E2E, one fresh whole-slice review and at most one coalesced Important/Critical correction pass. Verify signed source, recovery and current hosted/protected checks before delivery. Reuse only byte-proven unchanged baseline evidence.
