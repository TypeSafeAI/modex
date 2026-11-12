# Modex in a browser

The desktop interface at **https://app.modex.codes**, on an in-memory demo workspace. It is the
same React renderer as the Mac app (`apps/desktop/src/renderer`) and the same disposable demo
the Store edition offers (`apps/store-desktop/src/main/demo.ts`), put behind the renderer's
bridge in the page itself.

Nothing here runs a model, a CLI, a shell or a file operation. Threads, the approval, the
sample README change, follow-up replies and terminal echo are scripted and live in the tab's
memory; a reload or **Reset demo** starts again. After the page has loaded it makes no further
requests, and its Content-Security-Policy allows none beyond its own origin. Coding with Claude
Code or Codex stays in the Mac app; there is no hosted or API mode.

- `src/demo-bridge.ts` wraps `StoreDemo` as a `ModexBridge` (`platform: "demo"`), with copy that
  points to the Mac app rather than to a paired host, and starts in the graphite theme.
- `src/main.ts` installs the bridge on `window.modex`, then loads `src/shell.tsx`. The renderer
  reads the bridge once at module load, so the order matters.
- `src/shell.tsx` shows the demo banner (what is simulated, Reset demo, Download for Mac) above
  the app. Space, Analytics and Code Review are off, as in the Store demo, and preferences are
  not saved. Below 760 px the desktop panes do not fit; the page shows a short explanation and
  a link to the site instead.

## Develop and verify

From the repository root:

```sh
pnpm install
pnpm web:dev                          # http://127.0.0.1:5179
pnpm web:build
pnpm --filter @modex/web typecheck
pnpm --filter @modex/web test:e2e
```

The browser tests cover the approval, a follow-up, Reset demo, adding a project without a
folder prompt, the narrow-screen fallback, a clean console, and that every request stays on
the page's own origin. Set `MODEX_WEB_TEST_PORT` to move the test port (default 5189).

## Deploy

Vercel project `modex-app`, team `0xbuns`, **Root Directory `apps/web`**. `vercel.json` here
installs the workspace with the pinned pnpm, builds `@modex/web`, serves `dist`, and sets the
security headers (including the Content-Security-Policy with `frame-ancestors 'none'`). There
are no functions and no environment variables.

For a manual production deployment, from `apps/web`:

```sh
vercel link --yes --project modex-app --scope 0xbuns
vercel build --prod --scope 0xbuns
vercel deploy --prebuilt --prod --scope 0xbuns
```

The custom domain is `app.modex.codes`, a CNAME to Vercel at the `modex.codes` DNS host.
