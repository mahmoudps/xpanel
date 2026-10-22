# Library decisions

Every dependency was verified on 2026-10-22 against the npm registry, repository activity, published security advisories and its license (permissive licenses only for shipped code), then the per-layer picks were reconciled into one stack. Changing a pick requires a new verification of the same kind.

## Stack

| Area | Pick | Version | License | Used by | Why |
|---|---|---|---|---|---|
| Runtime | Node.js 24 LTS (official binary bundled under /opt/xpanel/runtime) | 24.22.1 | MIT | apps/api, apps/agent, account-UID helpers, all tooling | Current Node 24 LTS security release. Ships node:sqlite (SQLite 3.51.3), native type stripping and node:crypto (AES-GCM, HKDF, argon2). The distros are behind (Ubuntu ships Node 12 and 18), so bundling one signed binary gives all four OSes the same runtime and OpenSSL. Verify it against SHASUMS256.txt.asc. |
| Panel index / operational database | node:sqlite (built into Node), one WAL file at /var/lib/xpanel/index.db | Node 24.22.1 built-in (SQLite 3.51.3) | MIT (Node) / public domain (SQLite) | packages/db (index, sessions, login attempts, jobs, metrics history, audit index); apps/api and apps/agent through @xpanel/db | Desired state lives in files, so the database only holds rebuildable data. There is no database server and no dependency, it uses about 0 MB when idle, and it runs in-process. Tested live on Node 24: WAL, STRICT tables, FTS5 with unicode61 remove_diacritics (Arabic and Latin search), json_extract, UPSERT ... RETURNING and the backup() export all work, with no ExperimentalWarning. Tests run against the same engine as production (':memory:' or a temp file). |
| Query layer over SQLite | own typed prepared-statement helpers + row mappers in packages/db (no ORM) | in-repo | project | packages/db repos | The index holds about 10 rebuildable tables, so hand-written SQL behind small typed repos is the clearest SSoT. Migration SQL is the schema truth, and a schema test compares PRAGMA table_xinfo against the TS row descriptors, so the types cannot drift. No dependency, as STANDARDS requires. |
| Index DB migrations | existing in-repo expand-only runner (migrate.ts + sql-lexer.ts) ported to SQLite | in-repo | project | packages/db; run at start by apps/api and apps/agent | Keeps the checksum, gap and expand-only lint guarantees. BEGIN IMMEDIATE replaces pg_advisory_xact_lock to serialize the API and agent. SQLite DDL is transactional. Upgrade snapshots use node:sqlite backup(). Under the prelaunch policy the single init migration is edited in place. |
| Desired-state files | JSON (RFC 8259) files per entity, written atomically with node:fs (temp, fsync, rename, fsync dir), validated by zod schemas from packages/core via packages/state | Node 24.22.1 built-in + zod 4.6.7 | MIT | packages/state (new), apps/api (writer, as the xpanel user), apps/agent (re-validating reader, root) | Like cPanel, config files are the source of truth, so a broken DB never loses a setup. JSON needs no parser dependency, is strict, and serializes deterministically (stable key order from the schema, 2-space indent, trailing newline), so generations diff cleanly. |
| API to agent wake-up and synchronous jobs (replaces LISTEN/NOTIFY) | HTTP/1.1 over the unix socket /run/xpanel/agent.sock: Hono on the agent, hono/client in the API with an undici Agent({connect:{socketPath}}) dispatcher | undici 8.12.1 (with hono 4.13.13, @hono/node-server 2.1.5) | MIT | apps/api (client), apps/agent (server) | STANDARDS chose the socket. Reusing Hono gives status codes, streaming bodies (file-manager uploads), zod-validated typed routes and in-process tests through app.request(). undici is the Node core team's HTTP client: zero dependencies, 0 advisories on 8.12.1, engines node >=22.19. Socket mode is 0660, group xpanel. |
| HTTP framework | hono | 4.13.13 | MIT | apps/api, apps/agent, apps/web (hono/client types only) | Zero dependencies, ESM, Fetch-API based, with built-in secure-headers, body-limit, request-id, timeout and context-storage. app.request() runs tests without sockets, and hono/client types the web client from the same routes. 0 advisories affect 4.13.13. Repo has 32.6k stars and was pushed 2026-10-17. |
| Node listener | @hono/node-server | 2.1.5 | MIT | apps/api (/run/xpanel/api.sock behind Nginx), apps/agent (/run/xpanel/agent.sock) | The official adapter: zero dependencies, peer hono ^4 \|\| ^5. createAdaptorServer returns a node:http Server that listens on a unix socket, so neither process opens a TCP port. |
| Validation + shared schemas (API, forms, router search, state files) | zod (schemas in packages/core/src/schemas) | 4.6.7 | MIT | packages/core, packages/state, apps/api, apps/agent, apps/web | Zero dependencies. z.toJSONSchema targets draft 2020-12 for OpenAPI 3.1, and .meta({id}) on plain zod becomes OpenAPI components (verified by the backend researcher). It implements Standard Schema, so TanStack Form and Router validateSearch use the same schemas with no adapter. core is pure (no node: imports, checked), so web can import its schemas at runtime: one truth for API, forms, state files and types (z.infer). |
| OpenAPI 3.1 from the same schemas | @hono/zod-openapi | 1.6.3 | MIT | apps/api | createRoute() both validates and documents, so the spec cannot drift. getOpenAPI31Document emits 3.1.0, peer hono >=4.10 (ready for v5), and it bundles @hono/zod-validator. Generate openapi.json at build time into the release instead of holding it in API memory, and have a test assert it is current. |
| Agent request validation | @hono/zod-validator | 0.9.1 | MIT | apps/agent | Already in the lockfile through @hono/zod-openapi, so it adds nothing new. The agent's internal socket needs validation but not an OpenAPI document, which keeps its idle RSS down. |
| Errors (RFC 9457) | own apps/api/src/http/problem.ts + problem catalog in packages/core | in-repo | project | apps/api, apps/agent, apps/web | Small spec. A zod Problem schema registered once, application/problem+json, RFC 6901 pointers in errors[], 400/415/422/429 mapped per RFC 9110/6585, and no stack leaks. |
| Security headers / CSRF / CORS | hono/secure-headers + own Fetch-Metadata CSRF middleware; no CORS (same origin) | hono 4.13.13 | MIT | apps/api | The built-in hono/csrf skips application/json. Our middleware allows Sec-Fetch-Site same-origin, otherwise requires an exact Origin match, and returns 415 for other media types. Cookie sessions use SameSite=Strict. Nginx is the single owner of HSTS and the SPA CSP. |
| Sessions, API tokens, login lockout and rate limiting | own modules on node:sqlite (sessions, login_attempts tables) + in-memory token bucket for the global per-IP limit | in-repo | project | apps/api, packages/db | Session token: 256-bit random, only SHA-256 stored, __Host- cookie, 30 min idle / 12 h absolute, rotated on login/2FA/privilege change, 5 min step-up for destructive actions. API tokens: xpt_ prefix, hashed, scoped, expiring, optional CIDR. Lockout by (username, IP) and IPv6 /64 uses UPSERT ... RETURNING, which is atomic because the API is one process with a synchronous in-process DB. 429 + Retry-After. |
| Password hashing (Argon2id, RFC 9106) | @node-rs/argon2 | 2.2.2 | MIT | apps/api | Prebuilt napi-rs binaries with no install script and npm provenance; measured 6-13x faster than node:crypto.argon2. Parameters reconciled with the 1 GB budget: RFC 9106 second option (m=64 MiB, t=3, p=4) behind a semaphore of 2 concurrent hashes (at most 128 MiB transient), rehash on login when parameters change. |
| TOTP 2FA (RFC 6238/4226) | @otplib/totp + @otplib/plugin-crypto-node + @otplib/plugin-base32-scure | 13.5.0 | MIT | apps/api | The otplib v13 core with HMAC on node:crypto. RFC 6238 Appendix B vectors and replay rejection verified by the backend researcher. 160-bit secret, encrypted at rest. The code field allows paste and autocomplete=one-time-code (WCAG 3.3.8). |
| Passkeys (WebAuthn) | @simplewebauthn/server (+ @simplewebauthn/browser in web) | 14.0.3 (browser 14.0.0) | MIT | apps/api, apps/web | The reference implementation; past its only advisory. Phishing-resistant second factor for root and resellers. Load it with dynamic import() so it costs no idle RSS. |
| Secrets at rest + config | node:crypto AES-256-GCM + HKDF-SHA256 envelope; zod config schema; systemd LoadCredential | Node 24.22.1 | MIT | packages/core (codec), apps/api, apps/agent | No dependency, FIPS-capable, AAD bound to table:column:id, key ring with kid for rotation. Secrets never go into env vars or files the API can read. |
| Streaming multipart uploads | @remix-run/multipart-parser | 1.0.0 | MIT | apps/api (file manager uploads, streamed to the agent socket) | Parses Web streams with size and part limits, so uploads are never buffered. One MIT dependency, 0 advisories. Load it lazily. |
| Logging | pino (pino-pretty in dev only) | 10.4.0 (pino-pretty 13.2.0) | MIT | apps/api, apps/agent | Fastest JSON logger, journald-friendly, built-in redaction. Our own ~20-line middleware binds request-id and principal. |
| API docs (dev) + spec validation (test) | @scalar/hono-api-reference (dev-only entry apps/api/src/dev.ts) + @readme/openapi-parser | 0.12.12 / 9.1.0 | MIT | apps/api devDependencies | Scalar is mounted only by a dev entry, so production code never imports a devDependency (knip and dependency-cruiser enforce this). The parser validates the generated OAS 3.1 in vitest. |
| Cron preview | croner | 10.0.1 | MIT | apps/api (next-run preview), packages/render (devDependency for the property test) | Zero dependencies, ESM, nextRuns() with no scheduler. Our own cron(5) validator in core runs first. |
| Webmail IMAP / SMTP / MIME | imapflow + nodemailer + postal-mime | 2.4.2 / 10.1.1 / 4.0.6 | MIT / MIT-0 / MIT-0 | apps/api (xMail, lazy-loaded) | Streaming per-part downloads, IDLE and XOAUTH2 against Dovecot with short-lived ES256 JWTs signed by node:crypto (no master user, no stored mailbox passwords). nodemailer has 0 deps and 10.1.1 is past every advisory (highest fixed range is <10.0.9). postal-mime has 0 deps. 0 advisories on all three pinned versions. |
| MariaDB client (customer DBs) | mysql2 | 3.24.6 | MIT | apps/agent | socketPath + unix_socket auth (no password anywhere), structured errors, transactions for grants. Clear of the 2026 advisories. |
| Archives (tar, gzip, zip) | tar-stream + node:zlib (tar/gzip, zstd); yauzl (zip read); yazl (zip write); all entries pass through ArchiveGuard | tar-stream 3.2.2, yauzl 3.4.0, yazl 3.3.1 (+ @types/yauzl 3.4.0, @types/yazl 3.3.1) | MIT | packages/lifecycle (archive module, used by the agent's account-UID helper) | Pure parsers that never touch the filesystem, so every path decision goes through our guard. yauzl rejects size mismatches (zip bombs) and '..'/absolute names. tar-stream ships its own types. |
| File type / Content-Type | file-type + mime | 22.2.0 / 4.1.1 | MIT | apps/agent (account-UID helper); mime also in apps/api | Magic-byte sniffing on streams (past its advisories) plus a zero-dependency extension map, with nosniff and Content-Disposition: attachment. |
| Host execution, systemd, firewall | node:child_process runner port (argv only, timeouts, process-group kill, output caps) driving systemctl/systemd-run/busctl and nft -c -f / nft -f | Node 24.22.1; distro systemd 249-257, nftables 1.0.2-1.1.x | MIT (Node); OS binaries are invoked, not linked | apps/agent, packages/os, packages/render, packages/lifecycle | A root process gets no third-party exec layer. Account jobs run as transient units in xpanel-<uid>.slice as the account UID. nft text files are reviewable, and nft -f applies them atomically. |
| DNS server | PowerDNS Authoritative auth-51 from repo.powerdns.com, BIND backend on zone files rendered by the agent; pdns_control bind-reload-now / bind-add-zone and pdnsutil (bind-dnssec-db) through the runner | 5.1.5 | GPL-2.0 (separate daemon, not redistributed) | packages/os, packages/render (services/dns.ts), apps/agent | STANDARDS chose the BIND backend so DNS needs no database. Zone files come from state, so no HTTP API client is needed. auth-51 is the supported release train on all four OSes; the distro builds are EOL or differ per OS. |
| ACME (RFC 8555, wildcard) | lego (static binary), DNS-01 through its exec provider calling an xpanel agent hook; HTTP-01 through a shared webroot | 5.5.2 | MIT | apps/agent (TLS reconciler), packages/os (bundle manifest) | Full RFC 8555 with ARI and profiles. Binaries have checksums plus GitHub attestations. The exec provider (providers/dns/exec checked in the repo) lets the TXT record flow through state -> rendered zone -> reload, which fits the BIND backend. lego runs as the unprivileged xpanel-acme user. |
| Mail, FTP, SSH, web engines (OS services) | distro Postfix 3.5-3.8 + Dovecot 2.3 (renderer refuses 2.4); Pure-FTPd 1.0.54 built by xPanel; OpenSSH internal-sftp + rsync; mpm-itk (Ubuntu distro, EL xPanel-built 2.4.7-04); OpenLiteSpeed 1.9.3 vendor repo (optional) | see pick | OS packages (Pure-FTPd ISC-style, mpm-itk Apache-2.0 redistributed by us; GPL daemons installed, never bundled) | packages/os, packages/render, apps/agent, packages/lifecycle | Accepted from the system research. Sieve is rendered and checked with sievec (drop dovecot-managesieved). Transfers use ssh -o BatchMode with pinned host keys plus rsync, never scp. |
| UI framework | react + react-dom (static SPA served by Nginx) | 19.3.1 (@types/react 19.3.0, @types/react-dom 19.3.0) | MIT | apps/web | React Aria and the TanStack stack target React. No SSR process (resource budget). react+react-dom measured 65.1 KB gzip. |
| Build | vite + @vitejs/plugin-react + @tailwindcss/vite | vite 8.3.4, @vitejs/plugin-react 6.1.2 | MIT | apps/web | Rolldown/oxc pipeline that the TanStack, Lingui, Tailwind and Vitest plugins all target. 8.3.4 is past every Oct-2026 vite advisory (all affect <=8.3.2, verified) and outside the 7-day window. |
| React Compiler (+ its lint) | babel-plugin-react-compiler via @rolldown/plugin-babel + @babel/core (one Babel pass shared with the Lingui preset) | 1.0.0 / 0.2.4 / 7.29.7 | MIT | apps/web (vite.config.ts) | Automatic memoization for dense tables and forms. Babel 7.29.7 is the same major router-plugin needs (^7.29.7), so there is one Babel in the tree. The compiler lint gap without ESLint is closed by panicThreshold:'all_errors' in the CI build (option confirmed in the 1.0.0 dist). |
| Router | @tanstack/react-router + @tanstack/router-plugin (autoCodeSplitting) | 1.170.44 / 1.168.46 | MIT | apps/web | Type-checked paths and search params, with validateSearch taking zod 4 directly. Loaders call queryClient.ensureQueryData. Per-route pending/error/notFound components. The plugin's peer range (^1.170.44) and shared router-core 1.171.37 were checked. Measured 25.8 KB gzip. |
| Server state | @tanstack/react-query (+ devtools, dev-only, lazy) | 5.104.2 | MIT | apps/web | Cache, optimistic mutations with rollback, and refetchInterval polling of reconcile jobs ('applied in generation #N'). queryOptions are shared with router loaders. Measured 9.9 KB gzip. |
| Tables | @tanstack/react-table rendered through react-aria-components Table | 9.3.1 | MIT | apps/web (one DataTable) | v9 opt-in features and React Compiler compatibility. Server mode is fed from router search. React Aria owns selection, keyboard grid, RTL and Virtualizer. Measured route increment +13.2 KB gzip. |
| Forms | @tanstack/react-form | 1.33.5 | MIT | apps/web | Standard Schema: the same core zod schemas the API validates with, no resolver. onSubmitAsync maps RFC 9457 pointers onto fields. Controlled fields bind to React Aria validationBehavior='aria'. Measured +16.3 KB gzip. |
| Accessible primitives, toasts, dates | react-aria-components (+ @react-aria/optimize-locales-plugin en-US/ar-AE, @internationalized/date) | 1.22.1 / 2.1.0 / 3.12.4 | Apache-2.0 | apps/web | Widest WCAG 2.2 coverage, built-in Arabic strings, RTL keyboard handling, Islamic calendars, Arabic-Indic digit parsing, Virtualizer, keyboard drag-and-drop, Autocomplete for Ctrl/Cmd+K. One notify module wraps UNSTABLE_Toast. |
| Styling | tailwindcss + tailwind-variants + tailwind-merge | 4.3.3 / 3.3.1 / 3.7.0 | MIT | apps/web | @theme tokens from the design system, logical-property utilities plus rtl: variants, and data-* variants for React Aria states. Zero runtime deps. |
| i18n | @lingui/core, @lingui/react (+ @lingui/cli, @lingui/vite-plugin, @lingui/babel-plugin-lingui-macro dev) | 6.9.1 | MIT | apps/web | ICU plurals cover Arabic's six categories, catalogs compile ahead of time (about 2 KB runtime), and lingui compile --strict gates 100% Arabic. 6.9.1 already exports linguiTransformerBabelPreset (checked). The macro plugin is a required peer the research left out. |
| Icons | lucide-react | 1.57.0 | ISC | apps/web | Named ESM imports tree-shake per icon, 0 deps. Newest version outside the window (1.61.0 is from 2026-10-21). |
| Charts (metrics) | uplot behind our own <MetricChart> (figure + text summary + React Aria Table view, dash patterns, scale dir -1 for RTL) | 1.6.32 | MIT | apps/web (lazy metrics routes) | Measured 21.4 KB gzip. recharts measured 102.5 KB gzip for LineChart+AreaChart with React external, which breaks the STANDARDS 60 KB per-route chunk budget. Zero deps and fast on long time series. Accessibility comes from the summary and the table equivalent (WCAG 1.1.1); the canvas is aria-hidden. |
| Webmail HTML sanitizing | dompurify, rendering into a sandboxed iframe (srcdoc, CSP default-src 'none', remote images blocked or proxied) | 3.4.17 | (MPL-2.0 OR Apache-2.0); elect Apache-2.0 | apps/web (xMail message view chunk) | The researchers left this gap. DOMPurify is the de-facto sanitizer, with 0 advisories on 3.4.17 (fixes through 3.4.16) and its repo pushed 2026-10-16. Defence in depth with the iframe sandbox. |
| Type checking | typescript 7 native tsc, installed with Microsoft's documented alias pair: "@typescript/native": "npm:typescript@7.0.2" (provides tsc) and "typescript": "npm:@typescript/typescript6@6.0.2" (TS 6 API for dependency-cruiser and the Stryker checker) | 7.0.2 (+ @typescript/typescript6 6.0.2) | Apache-2.0 | repo root; every package typecheck script | 7.0.2 is npm latest (GA). It gives the same diagnostics as 6.0.3 on all 9 projects and type-checks 3-6x faster. tsc and tsgolint then share TS 7 semantics. The alias pair is Microsoft's own recommendation (TS 7.0 announcement, Nx docs) because 7.0 ships no JS API. |
| Lint (incl. type-aware) | oxlint + oxlint-tsgolint (root config, per-path overrides, type-aware rules) | 1.88.0 / 7.0.2004 | MIT | repo root | About 600 rules (eslint, typescript, unicorn, react/hooks, jsx-a11y, import/no-cycle and extensions, vitest, promise) plus 59 of 61 typed rules on the real TS 7 checker. Measured 1.0 s plain, 3.3-4.1 s type-aware. It found real defects (nftables 'forward' chain non-exhaustive). oxlint's peer range (tsgolint >=7.0.2003) was checked. Also enforce banned imports (hono/jsx, serve-static, jwt, ssg, cors) and .ts extensions. |
| Format | oxfmt (Tailwind class + import sorting built in) | 0.73.0 | MIT | repo root | Matches Prettier output, same Oxc toolchain, measured 1.9 s, no plugins needed. |
| Unit, integration, component tests + coverage | vitest + @vitest/coverage-v8 + @vitest/browser-playwright + vitest-browser-react | 5.0.5 (all vitest/@vitest/*), vitest-browser-react 2.3.0 | MIT | repo root (projects per package); apps/web browser project | 5.0.5 fixes GHSA-p458-7748-mcp3 (server.fs.deny misapplied in @vitest/browser and @vitest/ui <5.0.5, published 2026-10-21; verified), so the quality layer's 5.0.4 is rejected. Browser mode gives real layout, focus, Intl and RTL for React Aria tables. Drop jsdom and @testing-library/react. |
| Property + mutation testing | fast-check + @fast-check/vitest; @stryker-mutator/core + typescript-checker (command test runner, nightly, pure packages only) | 4.10.2 / 0.5.0; 10.0.0 / 10.0.0 | MIT; Apache-2.0 | packages/core, render, os, lifecycle tests; root stryker.config.json | Properties: quoting never escapes in config/nft output, IDNA round trips, caps are monotonic, cron next-runs agree with croner and systemd. Stryker is the only maintained JS mutation tool. Its checker uses the TS 6 API through the alias. |
| E2E + accessibility | @playwright/test + @axe-core/playwright (en LTR and ar RTL projects; tags wcag2a/aa, wcag21a/aa, wcag22aa; own 44 px target assertion) | 1.64.1 / 4.13.0 | Apache-2.0 / MPL-2.0 (dev only) | apps/web e2e walk-throughs | Three browsers, aria snapshots, keyboard walk-throughs for every ready tool. 0 advisories on both versions. |
| Architecture, dead code, duplication | dependency-cruiser + knip + jscpd | 18.6.0 / 6.41.0 / 5.4.1 | MIT / ISC / MIT | repo root (pre-push + CI) | dependency-cruiser checks resolved paths and type-only edges: web may import @xpanel/api only as types, packages never import apps, no cycles, no prod-to-devDep imports (0 violations on 199 modules). knip finds unused files and exports (it found 4 files, 14 exports). jscpd v5 near-miss clones surface the 6 duplicate validate.ts modules. |
| Git hooks + commit conventions + release | lefthook (via root 'prepare', its postinstall is not allowed); @commitlint/cli + config-conventional + config-pnpm-scopes; release-please (googleapis/release-please-action v5.0.0 pinned by SHA, enabled at launch) | 2.2.2; 21.2.3 / 21.2.3 / 21.2.2; action v5.0.0 | MIT; MIT; Apache-2.0 | repo root | Parallel staged-file hooks with no lint-staged. Scopes are read from the pnpm workspace (SSoT). One product SemVer comes from Conventional Commits, and the prelaunch policy holds versions until launch. |
| Package manager + supply chain | pnpm with pnpm-workspace.yaml: minimumReleaseAge 10080, trustPolicy no-downgrade, blockExoticSubdeps true, strictDepBuilds true, allowBuilds (explicit false entries only), savePrefix '', catalogMode strict + catalog: as the version SSoT, engineStrict, verifyDepsBeforeRun error | 12.13.0 | MIT | repo root | The current pin pnpm@10.7.1 is affected by 26 GHSA advisories (14 high), checked live today. pnpm 12 fails on unknown settings and has built-in sbom, licenses and audit signatures (settings verified on 12.13.0 by the quality researcher). blockExoticSubdeps blocks the delivery path used in the TanStack compromise. |
| Vulnerability, SBOM, license, secret and CI scanning | osv-scanner (gate) + pnpm audit signatures; pnpm sbom (CycloneDX 1.7, --prod --split); pnpm licenses + own scripts/check-licenses.ts; betterleaks; zizmor; actions/attest | 2.7.0; pnpm 12.13.0 built-ins; betterleaks 1.9.0; zizmor 1.30.1; actions/attest v4.2.2 (SHA-pinned) | Apache-2.0; MIT; MIT; MIT; MIT | CI, pre-push, release workflow | OSV includes the MAL- malicious-package feed. The SBOM and license data come from the same lockfile pnpm installs from. Betterleaks is the maintained Gitleaks successor. zizmor checks workflow security. |

## Rejected alternatives

**Runtime**

- Node 26.12.1: not LTS (lts:false)
- Distro nodejs packages: versions differ per OS and are too old
- Node 24.15.0 (the dev machine): older than the 2026-10-20 security release

**Panel index / operational database**

- PostgreSQL 18 (PGDG) + pg 8.23.1: a resident server of about 40-60 MB RAM, which the project's storage design and the 1 vCPU / 1 GB budget rule out
- better-sqlite3: native addon with an install script (pnpm build approval), duplicates the built-in
- @electric-sql/pglite / pglite-socket: no Postgres left to emulate
- libsql / Turso: extra native client for a feature node:sqlite already covers

**Query layer over SQLite**

- drizzle-orm 0.45.4: the latest stable has no node:sqlite driver; it exists only on 1.0.0-beta/rc dist-tags ('node-sqlite', 'rc'), and sqlite-proxy would be an adapter shim
- kysely 0.29.7: no node:sqlite dialect, and 4 high advisories in 2026
- prisma 7.x: codegen plus a separate DSL

**Index DB migrations**

- drizzle-kit 0.31.11: diff-generated DROP/RENAME, no checksum or expand lint
- node-pg-migrate 9.0.0 / graphile-migrate 1.4.1: Postgres-only

**Desired-state files**

- YAML (yaml 2.9.1): implicit typing ambiguities and a parser in the root agent's trust path; kept only for reading cPanel imports
- TOML: needs a library, weaker nested arrays
- write-file-atomic: a dependency for about 30 lines that must also fsync the directory

**API to agent wake-up and synchronous jobs (replaces LISTEN/NOTIFY)**

- Postgres LISTEN/NOTIFY: no Postgres
- own node:http socketPath fetch bridge: re-implements Request/Response, abort and streaming handling
- gRPC / custom JSON-lines protocol: heavier, or no HTTP semantics

**HTTP framework**

- fastify 5.12.7: CommonJS, 15 deps, ajv duplicates the zod SSoT, auth-bypass advisories 2026-09-30
- elysia 1.4.30: Bun-first
- h3 2.0.7: 11 advisories in 2026
- express 5.3.0 / koa 3.2.1: req/res API, no typed schemas
- hono 5.0.0-rc.1: release candidate; cut over in one change once 5.0.0 is the latest dist-tag

**Node listener**

- srvx 1.0.6: an extra layer from the h3 ecosystem
- raw node:http: re-implements the Request bridge and abort handling
- @hono/node-server/serve-static: 4 advisories; Nginx serves the SPA

**Validation + shared schemas (API, forms, router search, state files)**

- valibot 1.5.0: no first-party Hono OpenAPI binding, 2 advisories in 2025-26
- arktype 2.2.9: OpenAPI only through a third-party chain
- typebox 1.4.2: weaker refinements
- zod/mini for shared schemas: unclear @hono/zod-openapi support

**OpenAPI 3.1 from the same schemas**

- hono-openapi 1.5.0: peer ^4.11.2 blocks v5, standard-community chain
- zod-openapi 6.0.2: no route binding
- chanfana 3.4.0: Workers-oriented

**Agent request validation**

- @hono/zod-openapi in the agent: generator code in a process with a 50 MB budget
- hand-rolled hono/validator + safeParse: re-implements this helper

**Errors (RFC 9457)**

- http-problem-details 0.1.7 / problem-details-http 2.0.0: stale, no zod link
- Hono default HTTPException bodies: text/plain

**Security headers / CSRF / CORS**

- helmet 8.3.0: Express middleware
- hono/csrf: JSON is unchecked
- csrf-csrf tokens: needless state
- cors() by default: past origin-reflection advisories

**Sessions, API tokens, login lockout and rate limiting**

- rate-limiter-flexible 11.2.3: its SQLite store accepts only sqlite3, better-sqlite3 or knex (checked in the 11.2.2 source), not node:sqlite, and its insurance limiter exists for network stores
- better-auth 1.7.12: parallel user tables, 23 advisories including a critical 2FA bypass
- lucia 3.2.2: deprecated
- iron-session / hono-sessions: cannot be revoked
- hono/jwt: not revocable, 2026 advisories

**Password hashing (Argon2id, RFC 9106)**

- node:crypto.argon2: 6-13x slower in the backend benchmark, depends on OPENSSL_WITH_ARGON2, no PHC encoding
- argon2 0.45.1: CommonJS, install script
- hash-wasm 4.12.0: last release 2024-11
- bcrypt: 72-byte limit

**TOTP 2FA (RFC 6238/4226)**

- otplib 13.5.0 umbrella: pulls noble hashes needlessly
- otpauth 9.5.2: no replay guard
- @oslojs/otp 1.1.0: stale
- @epic-web/totp 4.0.1: stale

**Passkeys (WebAuthn)**

- @passwordless-id/webauthn 2.4.1: thinner attestation checks
- better-auth passkey plugin: tied to better-auth

**Secrets at rest + config**

- @noble/ciphers 2.4.0 / libsodium-wrappers 0.8.4: duplicate primitives Node already has
- @t3-oss/env-core / envalid / env-schema: zod already covers config

**Streaming multipart uploads**

- c.req.parseBody(): buffers the whole body
- @fastify/busboy 3.2.4: 3 advisories
- busboy 1.6.0: repo stale since 2024
- formidable 3.5.4: 2 advisories

**Logging**

- hono-pino 0.10.3: stale
- @logtape/logtape 2.4.2: less mature redaction
- winston 3.19.0: 11 deps, slower

**API docs (dev) + spec validation (test)**

- Scalar in production: loads its bundle from a CDN (CSP)
- @apidevtools/swagger-parser 13.1.0: CommonJS
- @redocly/cli 2.67.1: CLI only

**Cron preview**

- cron-parser 5.10.2: CommonJS + luxon
- node-cron / cron: in-process schedulers

**Webmail IMAP / SMTP / MIME**

- emailjs-imap-client 3.1.0: dead since 2022
- mailparser 3.12.2: 8 deps
- executing sendmail: bypasses SMTP AUTH policy
- jose 6.2.13: unnecessary for a single ES256 sign

**MariaDB client (customer DBs)**

- mariadb 3.5.4: LGPL-2.1, 4 advisories in 2026-10
- mariadb CLI for DDL: SQL in argv, stderr parsing

**Archives (tar, gzip, zip)**

- tar 7.5.22: BlueOak-1.0.0, 21 advisories
- adm-zip 0.6.1: 9 advisories, in-memory
- archiver 8.0.0: 9 deps
- @zip.js/zip.js 2.24.0: no name/size enforcement
- jszip: in-memory, dual GPL

**File type / Content-Type**

- mmmagic: native addon
- mime-types 3.0.2: CommonJS, stale db

**Host execution, systemd, firewall**

- execa 10.2.0: 12 deps in root
- tinyexec 1.3.1: PATH-hijack default
- dbus-next 0.10.2: dead since 2021
- nftables-napi 0.7.1: AGPL
- nft JSON as the write format: quirks across 1.0.2-1.1.x

**DNS server**

- global fetch + zod PowerDNS API client: the BIND backend does not support zone edits through the API, and API writes would bypass the state files
- pdns-backend-pgsql/gsqlite3: a second store of truth
- distro pdns 4.5/4.8/5.0: EOL or differing

**ACME (RFC 8555, wildcard)**

- lego pdns provider: needs API rrset PATCH, which the BIND backend lacks
- acme-client 5.4.0: stale, node-forge advisory
- certbot 5.8.0: distro versions differ, Python
- @root/acme: MPL, dead

**Mail, FTP, SSH, web engines (OS services)**

- SFTPGo / Stalwart: AGPL
- vsftpd: one guest UID for all virtual users
- ssh2 1.17.0: pure-JS SSH, one maintainer
- distro pure-ftpd 1.0.50/1.0.52: missing CVE fixes

**UI framework**

- solid / svelte / vue: no primitive library at React Aria's i18n/RTL depth
- preact: compat risk with the Compiler and React Aria
- TanStack Start / RR framework mode: SSR server not wanted

**Build**

- vite 8.3.5: published 2026-10-21, inside the cooldown with no security need
- plugin-react-swc 4.3.3: cannot run React Compiler
- Rsbuild / webpack: plugins here are Vite-first

**React Compiler (+ its lint)**

- eslint-plugin-react-hooks 7.1.1: would need ESLint next to oxlint
- @babel/core 8.0.7: router-plugin still requires Babel 7
- native oxc compiler: README marks it experimental

**Router**

- wouter 3.13.0: Unlicense (outside the allow-list), untyped search, no loaders
- react-router 8.5.0: typegen only in framework mode, 20 advisories in 2026
- @tanstack/zod-adapter: zod 3 only

**Server state**

- SWR: weaker mutations
- RTK Query: brings Redux
- loaders alone: no shared cache

**Tables**

- ag-grid-community 36.2.0: own DOM/theme, server row model is Enterprise-only
- table v8: not Compiler-compatible
- @tanstack/react-virtual: conflicts with React Aria focus

**Forms**

- react-hook-form 7.90.0 + resolvers 6.0.0: watch() flagged as Compiler-incompatible, extra resolver
- @conform-to/react 1.21.2: built around server actions

**Accessible primitives, toasts, dates**

- radix-ui 1.8.1: no Combobox, DatePicker or grid
- @base-ui/react 1.9.0: no grid or calendar
- @ark-ui/react 5.39.3: 69 deps
- sonner / react-hot-toast: a second accessibility model

**Styling**

- class-variance-authority 0.7.1: stale, no slots
- UnoCSS / Panda / CSS Modules: more setup for tokens and RTL

**i18n**

- i18next 26.5.4: key-based, ICU parsed at runtime
- paraglide-js 2.29.1: not ICU
- use-intl / react-intl: runtime ICU parsing
- lingui 6.10.0: inside the 7-day window

**Icons**

- phosphor / tabler / heroicons: switching cost or too small a set

**Charts (metrics)**

- recharts 3.10.1: 102.5 KB gzip route chunk (measured), over budget
- echarts 6.1.0: about 359 KB
- chart.js 4.5.1: canvas, about a year without a release
- @visx: 16 deps
- d3-shape/d3-scale own SVG: modules not released since 2021-23

**Webmail HTML sanitizing**

- server-side sanitizing with jsdom: heavy in the API budget
- sanitize-html: htmlparser2-based, weaker against mXSS

**Type checking**

- typescript 6.0.3 alone: legacy line, 3-6x slower, and lint (tsgolint) would check with TS 7 semantics anyway
- @typescript/native-preview: abandoned channel, typescript-go archived 2026-08-31

**Lint (incl. type-aware)**

- eslint 10.13.0 + typescript-eslint 8.72.0: peer typescript <6.1.0 (verified), so typed lint is impossible on TS 7; 12-18x slower
- @biomejs/biome 2.6.2: typed rules use its own inference, not the TS checker
- vite-plus 1.3.0: an extra wrapper layer

**Format**

- prettier 3.9.10: slower, needs 2 plugins
- biome formatter: a second toolchain

**Unit, integration, component tests + coverage**

- vitest 5.0.4: affected by GHSA-p458-7748-mcp3
- jsdom 30.1.3 + @testing-library/react 16.3.3: no layout, so virtualized tables render 0 rows
- happy-dom 21.0.4: VM-escape history
- jest 30: CJS-first
- node:test: no Vite pipeline

**Property + mutation testing**

- @stryker-mutator/vitest-runner 10.0.0: false 'Survived' results on Vitest 5 (issues #6210/#6262/#6263, fixes #6214/#6260 unreleased)
- pnpm patchedDependencies on the runner: patch-style workaround

**E2E + accessibility**

- cypress: no real WebKit
- pa11y / Lighthouse: outside the flow
- @axe-core/playwright 4.14.0: inside the window until 2026-10-22T16:39Z

**Architecture, dead code, duplication**

- eslint-plugin-boundaries / @nx/eslint-plugin: need ESLint or Nx
- madge 8.0.0: no rule engine, last release 2024
- depcheck / ts-prune / unimported: archived or in maintenance

**Git hooks + commit conventions + release**

- husky 9.1.7: no release since 2024-11, needs lint-staged
- simple-git-hooks: no parallelism
- changesets 3.0.3: per-PR intent files duplicate commit intent
- semantic-release: no reviewable release PR

**Package manager + supply chain**

- pnpm 10.34.7: lacks allowBuilds, the unknown-setting failure and sbom
- pnpm 11.28.6: not the current line
- pnpm 12.14.0: eligible only from 2026-10-22T13:39Z and its settings are not verified
- npm 11 / yarn 4: no equivalent cooldown and trust controls

**Vulnerability, SBOM, license, secret and CI scanning**

- pnpm audit alone: no OSV or malware feed
- @socketsecurity/cli 1.9.1: proprietary SaaS
- cdxgen 12.8.6: 29 deps
- license-checker-rseidelsohn: walks node_modules
- gitleaks 8.30.1: feature-frozen
- trufflehog: AGPL
- zizmor 1.31.1: inside the window until 2026-10-22T23:16Z

## Package changes to apply

- GLOBAL: write every external version once in the pnpm-workspace.yaml `catalog:` (catalogMode: strict) and reference it as "catalog:" in package.json. Pins below are exact (savePrefix ''). Apply on or after 2026-10-22T14:30Z, when vitest 5.0.5 clears the 7-day minimumReleaseAge.
- root package.json: packageManager "pnpm@10.7.1" -> "pnpm@12.13.0" (add the +sha512 integrity suffix); engines.node ">=24" -> "^24.22.1".
- root devDependencies: replace "typescript": "~6.0.3" with "typescript": "npm:@typescript/typescript6@6.0.2" and add "@typescript/native": "npm:typescript@7.0.2"; "@types/node": "^24.0.0" -> "24.19.2"; "vitest": "^5.0.5" -> "5.0.5".
- root devDependencies add: @vitest/coverage-v8 5.0.5, fast-check 4.10.2, @fast-check/vitest 0.5.0, oxlint 1.88.0, oxlint-tsgolint 7.0.2004, oxfmt 0.73.0, knip 6.41.0, jscpd 5.4.1, dependency-cruiser 18.6.0, lefthook 2.2.2, @commitlint/cli 21.2.3, @commitlint/config-conventional 21.2.3, @commitlint/config-pnpm-scopes 21.2.2, @stryker-mutator/core 10.0.0, @stryker-mutator/typescript-checker 10.0.0.
- root scripts add: "prepare": "lefthook install", "lint": "oxlint --type-aware", "format": "oxfmt", "format:check": "oxfmt --check", "deps:check": "depcruise apps packages", "knip": "knip", "dup": "jscpd", "licenses": "node scripts/check-licenses.ts", "bundle:check": "node scripts/check-bundle.ts" (own zero-dependency gate: initial JS <= 200 KB gzip, each route chunk <= 60 KB gzip, read from the Vite manifest). "typecheck" stays and now runs TS 7 tsc.
- pnpm-workspace.yaml add: minimumReleaseAge: 10080, trustPolicy: no-downgrade, blockExoticSubdeps: true, strictDepBuilds: true, allowBuilds: {} (after the first clean install add an explicit `<name>: false` for every dependency pnpm reports with build scripts, e.g. lefthook; none may run), savePrefix: '', catalogMode: strict, catalog: {...every pin listed here}, engineStrict: true, verifyDepsBeforeRun: error, resolutionMode: highest.
- packages/core: add dependency zod 4.6.7. Domain, API request/response and problem-catalog schemas move to packages/core/src/schemas, and core types become z.infer of them.
- packages/state (NEW, per STANDARDS): dependencies @xpanel/core workspace:*, zod 4.6.7. No other deps (node:fs atomic store).
- packages/db: remove drizzle-orm ^0.45.4, pg 8.23.1, devDependencies @types/pg 8.23.1, @electric-sql/pglite ^0.5.11, @electric-sql/pglite-socket 0.2.14. No external dependencies remain (node:sqlite); keep @xpanel/core.
- packages/lifecycle: tar-stream "^3.2.2" -> "3.2.2"; yaml "^2.9.1" -> "2.9.1"; remove devDependency @types/tar-stream (3.2.x ships index.d.ts); add yauzl 3.4.0, yazl 3.3.1, devDependencies @types/yauzl 3.4.0, @types/yazl 3.3.1; add @xpanel/state workspace:* (STANDARDS: lifecycle <- state).
- packages/render: add devDependency croner 10.0.1 (property test of cronToOnCalendar). packages/os and packages/catalog: no changes.
- apps/api dependencies: hono "^4.13.13" -> "4.13.13"; @hono/node-server "^2.1.5" -> "2.1.5"; zod "^4.6.7" -> "4.6.7"; @node-rs/argon2 "^2.2.2" -> "2.2.2"; pino "^10.4.0" -> "10.4.0"; remove @hono/zod-validator (bundled by @hono/zod-openapi) and otplib; add @hono/zod-openapi 1.6.3, @otplib/totp 13.5.0, @otplib/plugin-crypto-node 13.5.0, @otplib/plugin-base32-scure 13.5.0, @simplewebauthn/server 14.0.3, @remix-run/multipart-parser 1.0.0, undici 8.12.1, croner 10.0.1, mime 4.1.1, imapflow 2.4.2, nodemailer 10.1.1, postal-mime 4.0.6, @xpanel/state workspace:*.
- apps/api devDependencies: remove @electric-sql/pglite; add @readme/openapi-parser 9.1.0, @scalar/hono-api-reference 0.12.12 (imported only by src/dev.ts), pino-pretty 13.2.0. scripts: "dev": "node --watch src/dev.ts".
- apps/agent dependencies: pino "^10.4.0" -> "10.4.0"; keep mysql2 3.24.6; add hono 4.13.13, @hono/node-server 2.1.5, @hono/zod-validator 0.9.1, zod 4.6.7, file-type 22.2.0, mime 4.1.1, @xpanel/state workspace:*. devDependencies: remove @electric-sql/pglite.
- apps/web dependencies: react "^19.3.1" -> "19.3.1"; react-dom "^19.3.1" -> "19.3.1"; @tanstack/react-query "^5.104.5" -> "5.104.2"; lucide-react "^1.61.0" -> "1.57.0"; remove wouter; add @tanstack/react-router 1.170.44, @tanstack/react-table 9.3.1, @tanstack/react-form 1.33.5, react-aria-components 1.22.1, @internationalized/date 3.12.4, tailwind-variants 3.3.1, tailwind-merge 3.7.0, @lingui/core 6.9.1, @lingui/react 6.9.1, uplot 1.6.32, dompurify 3.4.17, @simplewebauthn/browser 14.0.0, hono 4.13.13 (hono/client), zod 4.6.7.
- apps/web devDependencies: vite "^8.3.5" -> "8.3.4"; @vitejs/plugin-react "^6.1.2" -> "6.1.2"; tailwindcss "^4.3.3" -> "4.3.3"; @tailwindcss/vite "^4.3.3" -> "4.3.3"; @types/react "^19.3.0" -> "19.3.0"; @types/react-dom "^19.2.0" -> "19.3.0"; @playwright/test "^1.64.1" -> "1.64.1"; remove @testing-library/react and jsdom; add @tanstack/router-plugin 1.168.46, @tanstack/react-query-devtools 5.104.2, babel-plugin-react-compiler 1.0.0, @rolldown/plugin-babel 0.2.4, @babel/core 7.29.7, @lingui/cli 6.9.1, @lingui/vite-plugin 6.9.1, @lingui/babel-plugin-lingui-macro 6.9.1, @react-aria/optimize-locales-plugin 2.1.0, @vitest/browser-playwright 5.0.5, vitest-browser-react 2.3.0, @axe-core/playwright 4.13.0, @xpanel/api workspace:* (type-only import of AppType, enforced by dependency-cruiser).
- root vitest.config.ts: switch to `projects` (node project for apps/api, apps/agent and packages; browser project for apps/web through @vitest/browser-playwright). Drop the jsdom/tsx-in-node assumption.
- Non-npm pins (CI/bundle, not package.json): Node 24.22.1 runtime; lego 5.5.2 (checksum + gh attestation verify); PowerDNS auth-51 5.1.5 with the BIND backend; osv-scanner 2.7.0; betterleaks 1.9.0; zizmor 1.30.1; actions/attest v4.2.2 (SHA 1e69f48acb82d1966a394da916b4c1698aa569d6); release-please-action v5.0.0 (SHA 45996ed1f6d02564a971a2fa1b5860e934307cf7) wired at launch.
