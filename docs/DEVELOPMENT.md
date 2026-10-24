# Development runtime

Use the pinned workspace runtime and `pnpm dev` to start the API with `NODE_ENV=development` on Windows or Unix. The launcher sets this environment variable for its child process; shell-specific environment assignment is unnecessary. Existing database, credentials, listener, privilege and agent prerequisites still apply.

The server captures its trusted MFA policy once at startup and shares it across REST, HTML and WebSocket authentication. Only exact `NODE_ENV=development` disables second-factor verification. Production, an unset value, and every other value use optional enrollment: an enrolled account must verify its factor; an unenrolled account can sign in with its password. There is no request parameter or separate MFA environment override.

Development still verifies passwords and enforces lockouts, password changes, session expiry, CSRF, account isolation and role permissions. It preserves saved factors and recovery codes, does not consume recovery codes, and denies HTTP factor setup, enable and disable operations. Development sessions are never marked factor-verified; an enrolled account must authenticate again when the server resumes optional MFA mode. CLI recovery remains available under its existing authorization rules.

`pnpm start` and installed service definitions are unchanged. Changing the process environment after a listener starts does not change that listener's policy; restart with the intended environment.
