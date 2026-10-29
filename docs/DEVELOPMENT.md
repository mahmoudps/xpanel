# Development runtime

Use the pinned workspace runtime and `pnpm dev` to start the API with `NODE_ENV=development` on Windows or Unix. The launcher sets this environment variable for its child process; shell-specific environment assignment is unnecessary. Existing database, credentials, listener, privilege and agent prerequisites still apply.

The server captures its trusted MFA policy once at startup and shares it across REST, HTML and WebSocket authentication. Only exact `NODE_ENV=development` disables second-factor verification. Production, an unset value, and every other value use optional enrollment: an enrolled account must verify its factor; an unenrolled account can sign in with its password. There is no request parameter or separate MFA environment override.

Development still verifies passwords and enforces lockouts, password changes, session expiry, CSRF, account isolation and role permissions. It preserves saved factors and recovery codes, does not consume recovery codes, and denies HTTP factor setup, enable and disable operations. Development sessions are never marked factor-verified; an enrolled account must authenticate again when the server resumes optional MFA mode. CLI recovery remains available under its existing authorization rules.

`pnpm start` and installed service definitions are unchanged. Changing the process environment after a listener starts does not change that listener's policy; restart with the intended environment.
## Restart on source changes

Use the existing Node watch mode during local development:

```bash
node scripts/toolchain.mjs node scripts/dev.mjs --watch
```

`pnpm dev --watch` is the equivalent package command. The default `pnpm dev` remains a single start. Watch mode restarts the same development API child when an imported source file changes; it does not add a bundler, start an agent, install dependencies, or change the listener/database prerequisites above. Stop the foreground command when finished. Arguments after `--` are passed to the application without interpreting another watch flag.

During iteration, run the affected test files as described in [testing](TESTING.md). Keep the full required release checks; a focused local result does not replace them. Reuse the existing deterministic release packager and its authenticated archive/checksums for an approved promotion rather than rebuilding separately for each target. Signing, recovery and native activation prerequisites remain governed by the [operations runbooks](operations/runbooks.md).
