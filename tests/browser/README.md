# Browser acceptance

Run from the repository root with the pinned toolchain:

```sh
node scripts/toolchain.mjs pnpm test:browser
node scripts/toolchain.mjs pnpm test:browser --preflight
```

The suite launches the Chromium revision matched to `@playwright/test`. By default its cache is `.tools/playwright-browsers`; `PLAYWRIGHT_BROWSERS_PATH` may select another cache. Missing Chromium, unavailable dependencies, or the wrong Node runtime produce an explicit `blocked` result with exit code `2`. Preflight reports availability as `ready`, never successful application proof.

Each scenario creates a disposable SQLite/state directory and a real loopback HTTP server through the test-only `startPanelServer` (`apps/api/src/test-panel-server.ts`), an unbound application without entry-point profiles or handoff configuration. The injected host agent uses `FakeHostExecutor`; this suite cannot prove Linux services, workloads, TLS, quota enforcement, or production isolation. It does not certify the unavailable service tools or their workflows.

The scenarios exercise English and Arabic login errors, both themes, mobile RTL layout and field alignment, actual root bootstrap password change, password-only workspace access, optional MFA enrollment from the security page, replay rejection, recovery-code login, `disable-2fa` returning to password-only sign-in, CSRF denial, logout, and account-owner HTML authorization. Login and session creation happen through the actual UI. The test never injects session cookies or tokens. Axe checks serious and critical violations on the tested surfaces; they are not a complete accessibility certification.

The driver uses Playwright directly so automatic traces, screenshots, DOM snapshots, raw failure messages, and network-body attachments cannot retain credentials or MFA material. `browser-results.json` records controlled step/status observations, source hashes, browser/runtime versions, and explicit limitations. Set `XPANEL_BROWSER_OUTPUT` to choose the report directory; its default is `test-results/browser`.
