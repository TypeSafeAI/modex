# Current PR repository identity

The PR header and links retained the locator from the inbox or resolved link after an overview read returned a newer repository name. Main already supplies the current locator with the stable repository-id-bound overview; the renderer stored that overview without adopting its locator.

The renderer now updates the open PR's locator after its existing account and PR-key checks accept the overview. An unavailable refresh preserves the last accepted locator. This also keeps consumers of the open PR, including header links, on the same accepted identity. No read or write endpoint, permission, or provider behavior changes.

## Regression evidence

The Electron regression supplies an inbox row for `example-org/lending#73` and an overview for the same stable PR key at `current-org/lending-renamed#73`. Before the fix, it failed because the header remained `lending #73`. After the fix, it passed the header text and title, GitHub destination, copied destination, and preservation after an unavailable refresh (1 passed, 4.9 seconds). The fixture replaces reads and clipboard delivery; it performs no live GitHub write or provider call.

Independent review found no blockers and verified the existing account and stable-key guards, unavailable-refresh retention, and protection against older inbox locators. The unchanged full unit retry passed with 2,277 passes and 26 skips; full E2E also passed (479 desktop tests, 7 skips; 7 site tests). This repairs the C22 data-binding gap identified in the CR-8 refresh; original-reference comparison, human accessibility and live acceptance remain separate.

The first full validation attempt passed build, then reported a failure in the unchanged `remove completes the real CLI archive flow` test after 23.7 seconds. The worktree suite finished with 119 passes and one failure: the archive subprocess returned a null exit status at the success assertion, and the chained run stopped before desktop tests or E2E. At observation, machine load averaged about 178 and swap use was about 76 GB; the fixture has a 20-second subprocess timeout. Resource pressure is a hypothesis, not a proven cause. The original log is preserved. One unchanged, isolated retry of that exact test passed in 5.3 seconds; this diagnostic retry does not establish full validation.

The canonical `pnpm test` retry completed successfully: worktree 120 passed, core 16 passed, desktop 2,094 passed and 20 skipped, browser bridge 21 passed and 6 skipped, store 10 passed, and store desktop 16 passed. The chained `pnpm test:e2e` completed with exit 0: 479 desktop tests passed and 7 were skipped in 32.7 minutes, followed by 7 site tests passed in 9.1 seconds. The locator regression passed within that full run in 6.5 seconds. The five-launch transcript benchmark median was 113.4 ms against the unchanged 500 ms limit. The first full-run failure remains part of the record; this retry used the same source and test limits.
