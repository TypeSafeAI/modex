# CR-7: merge preflight

#326, AC4. Base: `main` at `a10fcc4`. Branch `cr7-merge-preflight`.

## What

`apps/desktop/src/main/engine/code-review-actions/merge-preflight.ts` is main-only and unwired, like
the draft/intent model next to it. It is a pure decision: from the revision the person reviewed and one set
of fresh `MergeFacts`, it returns `offer`, `reconfirm` or `unavailable`. It sends nothing to GitHub, and no
read supplies its facts yet. The fresh main-owned read of mergeability, allowed methods and queue rules
belongs to the merge increment, after Val answers the questions on
[#326](https://github.com/TypeSafeAI/modex/issues/326#issuecomment-6390523576).

The rules are on the [design page](../design/code-review.md#cr-7-preparation-local-drafts-and-intents).
In short:
- A changed scope, head or target asks for renewed confirmation.
- Unknown, blocked, queue-required and unreadable states stay unavailable, with Open in GitHub as the
  fallback.
- An offer lists only explicitly allowed methods and carries the reviewed head as `expectedHeadSha`.
- Check counts and model findings are refused as inputs.

## Limits

- The expected head SHA is not an atomic base lock. The adapter repeats the preflight right before
  dispatch, and GitHub enforces its own rules on the request.
- GitHub's `mergeable_state` is documented loosely. The mapping is conservative: anything outside
  `clean`, `has_hooks` and `unstable` is not offered.

## Validation

- **Red first.** `test/code-review-merge-preflight.test.ts`: all 6 tests failed against a stub that
  always returned unavailable. All 6 pass against the module.
- `pnpm build && pnpm test`: exit 0. Desktop unit: 1,944 passed, 17 skipped, 0 failed. The other
  suites passed with 5 skips.
- `pnpm test:e2e`: exit 0. Desktop: 451 passed, 7 skipped. Site: 7 passed.

Mock only. No merge, comment, review or live write was performed.
