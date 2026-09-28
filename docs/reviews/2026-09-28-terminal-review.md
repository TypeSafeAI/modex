# Embedded terminal review

The terminal panel runs one shell per thread in that thread's working directory. Use the
title-bar terminal button or Control + backtick to show or hide it. Hiding the panel or
closing the macOS window keeps the shell available while the app runs. Close and Restart
end the session; deleting a thread, removing its project, or quitting the app waits for cleanup.

## Lifecycle contract

Sending SIGHUP to an interactive shell leaves HUP-resistant foreground or background jobs
alive. Killing its process group also misses jobs that have their own process groups.
The POSIX terminal supervisor owns the session until every job in it has stopped, including
orphaned grandchildren and jobs left behind when the shell exits naturally.

The shell gets a separate foreground process group. Bash and Zsh retain Ctrl-C, Ctrl-Z,
and `fg` behavior. A private Unix socket carries the cleanup request and receipt; the app
waits for both the receipt and supervisor exit. A timeout retains ownership for a retry.
Supervisor death without a receipt rejects cleanup and preserves the working directory.
Deletion fences reject new coding turns and terminal opens while removal is in progress.

Process enumeration errors cannot certify cleanup. A disappearing process requires another
snapshot; stable zombies are recognized by PID and birth time after an initial rescan.
Commands that deliberately create a different OS session, such as a daemon using `setsid()`,
leave this ownership boundary.

The native helper is built before signing, unpacked from ASAR, and resolved from its real
path at runtime. Its universal macOS binary contains arm64 and x86_64 slices with a macOS 13
deployment target. The terminal panel's resize bounds use its parent pane, including after
the window shrinks to the supported minimum.

## Verification

Run source checks from a worktree:

```sh
npm run build
npm test
npm run typecheck
npm run test:e2e
```

Verify the installed bundle separately:

```sh
npm run dist -w @modex/desktop
MODEX_PACKAGED_APP="$PWD/apps/desktop/release/mac-arm64/Modex.app/Contents/MacOS/Modex" npm run test:e2e
codesign --verify --deep --strict apps/desktop/release/mac-arm64/Modex.app
```

Real-PTY regressions exercise resistant foreground jobs, orphaned background grandchildren,
natural shell exit, sibling isolation, timeout/retry, supervisor failure, and Bash/Zsh job
control. Electron scenarios exercise terminal input, history replay, restart, resize,
thread/worktree deletion, project removal, and app quit. These offline checks do not establish
live-provider behavior or human VoiceOver acceptance. Windows and Linux distribution remain
outside the release scope.

## Local results

On September 28, 2026, build and typecheck passed, along with 120 unit tests (15 core,
105 desktop). All 56 Electron scenarios passed against both source and the packaged
Apple Silicon app. The bundle and unpacked supervisor passed strict signature verification;
both supervisor slices report macOS 13.0 as their minimum.

An earlier source run failed at the opening chat's typed input and the terminal Ctrl-C
step, with dependent shared-state scenarios failing afterward. A complete source rerun and
the packaged run passed without changing those assertions. The cause of that first run's
input failures was not established. These results do not claim those tests are flake-free.
