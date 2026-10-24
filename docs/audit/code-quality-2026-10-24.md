# xPanel code-quality audit — 2026-10-24

Read-only audit of the tree at `bd5aa8acdee1ca8b7618b8a03290981cdc5804da`. No product code was changed. Visual UX judgement is out of scope; the UI lens below is code-measurable only.

## P0 — fix before any mail-auth or custom-include claim

1. **Fabricated DKIM public keys are written into desired DNS.** `POST /api/dns/email-auth/batch` sets `p=` to `sha256("dkim:" + domain)` base64, selector `default._domainkey`, not the live OpenDKIM key (`apps/api/src/extended-routes.ts:2547-2563`). RFC 6376 section 3.6.1 defines `p=` as the base64 public key. Impact: published records that cannot verify mail, and a control that looks successful (`{ ok: true, provisioned }`).
2. **OpenDKIM keeps signing domains that have left the requested set, and treats every customer domain as an internal host.** `ensureOpenDkimSigning` unions the previous `signing.json` domains back into `wanted` (`apps/agent/src/services/opendkim-live.ts:116-119`), writes `*@domain` into SigningTable (`:171`), and appends `domain` and `*.domain` to the file used as both `InternalHosts` and `ExternalIgnoreList` (`:165-172`, `:197-198`). There is no `/host/dkim-sign` route. Impact: a removed domain can still be signed, and customer domains are trusted as internal submission sources.
3. **The nginx/apache custom-include denylist does not match the directives that leave the vhost.** `NGINX_ISOLATION_FORBIDDEN` is anchored at line start and does not name `proxy_pass` (`packages/core/src/rules/custom-config.ts:19`). The same shape is used for Apache (`:26`). Accepted snippets are rendered into root-owned `0644` files (`packages/render/src/system/security-hardening.ts:438-447`). `packages/render/src/edge/nginx.ts` includes `vhostDir/*.conf` (`:140`) and does not include `/etc/xpanel/userdata`. Impact today: the bad snippet is stored and can be written, and it is not yet included by the edge renderer. Impact after any include is wired: `location / { alias /etc/; }` and `proxy_pass` are accepted. Non-root saves also send `force: true` (`apps/api/src/server.ts:2147-2149`) while the agent rejects force unless the caller is root (`apps/agent/src/server.ts:647`), so a connected agent rolls the save back. If the agent is absent, `triggerReconcile` returns null (`apps/api/src/server.ts:670-673`) and the saved config stays.

## Capsule

**Overall grade: C.**

The control plane is unusually careful for a prelaunch panel: unprivileged API unit, root agent on a `0660` Unix socket with `SO_PEERCRED`, Argon2id, audience-bound session cookies, CSRF, argv-only `execFile`, atomic state files, and `strict` TypeScript. README and STATUS still say the product is NO-GO with no verified capabilities. That self-assessment matches the code. Mail authentication can publish a key that is not a key. The privilege boundary leaks on the HTML path (`readFileSync` / `spawnSync` inside the API). The UI has a token block and then a second, larger source of raw colors and pixel literals. This grade is not a production approval.

| Lens | Grade |
|---|---|
| 1. Architecture and boundaries | B- |
| 2. Security | C- |
| 3. Correctness and data integrity | C |
| 4. Type safety | B |
| 5. Testing | C |
| 6. Performance and resilience | C+ |
| 7. Observability and operations | B- |
| 8. Frontend quality | C |
| 9. Maintainability | C |
| 10. Dependencies and supply chain | B- |
| 11. Delivery | C |
| 12. AI-change governance | B |
| Build / architecture quality | B- |
| Cleanliness | B |
| Single source of truth | D+ |
| QA | C |
| Code cleanliness | C |
| Balance | C- |
| Consistency | C |
| Best-practice adherence | C+ |
| UI code standards (code-measurable) | C- |

## What was measured, and what was not run

The VM has Node `v22.23.4`. The repo pins Node `26.12.1` (`.node-version`, `engines`, `scripts/toolchain.mjs`). `node_modules` is absent. These commands were **not** run, and this document does not invent their results:

- `pnpm install`, `pnpm test`, `pnpm typecheck`, `tsc`
- `pnpm audit`
- `madge`, `jscpd`, `knip`, `ts-prune`
- Stryker (no Stryker config is in the tree)
- OpenSSF Scorecard (no numeric score is claimed)
- Cyclomatic / cognitive complexity (a function splitter was tried and did not produce a trustworthy hotspot list)

Static facts that were counted on this tree:

- 502 text files, 182,374 lines, plus 8 non-text files, excluding `.git`.
- 165 `*.test.ts` / `*.spec.ts` files containing 1,909 `it(` calls. That is a source count, not a pass count.
- `@ts-expect-error`: 1 (`apps/agent/src/account-files.linux.test.ts:6`). No `@ts-ignore` or `@ts-nocheck` in the `*.ts` scan.
- `as any`: concentrated in `apps/web/src/accounts-actions.test.ts` (`window as any`).
- No `zod` / `valibot` / `typebox` import.
- No `security.txt`.
- No JWT authentication library in the scanned imports. ACME `application/jose+json` is a separate local use and was not fully reviewed.

## File coverage

“Section” means the cited regions were opened and checked. “Scan” means a walk or regex over the file, not a line-by-line reading. This audit does not claim that all 182,374 lines were read.

| Area | Text files | Lines | Depth |
|---|---:|---:|---|
| `packages/` | 255 | 83,909 | Scan. Section reads: `packages/core/src/rules/custom-config.ts`, `packages/render/src/system/security-hardening.ts` (custom includes), `packages/render/src/edge/nginx.ts` (include list), `packages/render/src/services/dns.ts` (`serialFor` / `bumpSerial`), `packages/state/src/atomic.ts`, `packages/catalog/src/data/specs.ts` size only |
| `apps/` | 168 | 74,869 | Section reads of agent server, OpenDKIM, API extended DNS batch, API `main.ts` host reads, API `server.ts` reconcile and custom-config PUT, `auth.ts` password and cookie helpers, web tokens, board-port, mail layout, shell motion. Remainder scanned |
| `docs/` | 15 | 7,437 | `docs/STANDARDS.md` typography section read. Other docs scanned for token and golden-ratio wording |
| `scripts/` | 25 | 7,118 | `scripts/board-fidelity.mjs` read through the exit path |
| `tests/` | 18 | 3,851 | Counted, not executed |
| `helpers/` | 2 | 2,332 | Inventoried. `helpers/account-files/xpanel-account-files.c` not line-read |
| `deploy/`, `.github/`, root metadata | remainder | remainder | `tsconfig.base.json` read. Workflow file not modified. Actions are owner-disabled; the workflow file was not treated as a running gate |

Largest modules by line count (balance evidence, not a complexity score):

| File | Lines |
|---|---:|
| `packages/catalog/src/data/specs.ts` | 9,184 |
| `packages/catalog/src/data/tools.ts` | 6,717 |
| `packages/catalog/src/data/navigation.ts` | 5,455 |
| `apps/api/src/extended-routes.ts` | 4,169 |
| `apps/api/src/server.ts` | 3,252 |
| `apps/web/src/tokens.ts` | 3,233 |
| `packages/state/src/store.ts` | 2,783 |
| `packages/state/src/extended-store.ts` | 2,679 |
| `apps/web/src/ws-client.ts` | 2,402 |
| `apps/agent/src/reconciler.ts` | 1,601 |
| `packages/render/src/extended/index.ts` | 1,540 |
| `scripts/package-release.mjs` | 1,380 |
| `apps/agent/src/server.ts` | 1,196 |
| `apps/web/src/board-port/xwhm-dashboard.ts` | 1,144 |
| `apps/web/src/board-port/xpanel-home.ts` | 1,088 |

## Lens evidence

### 1. Architecture and boundaries — B-

Intended split: unprivileged `xpanel` API, root agent, host tools behind argv-only `execFile` (`apps/agent/src/executor.ts:400`). Production `listenAgentSocket` refuses to run unless it is root on Linux and requires a peer credential on the accepted socket (`apps/agent/src/server.ts:976-1028`). `startAgentDaemon` builds the app without `expectedPeerUid` (`apps/agent/src/main.ts:129-140`) and listens with `{ gid }` only (`:144`). In-process `fetch` with no verified peer context returns null from the peer check when `expectedPeerUid` was not configured (`apps/agent/src/server.ts:245-250`). The socket path is the production control; the in-process path is a separate fail-open.

`apps/api/package.json` depends on `@xpanel/agent`. The API process also reads `/etc/postfix/main.cf` and `/etc/opendkim/signing.json` and runs `spawnSync('/usr/sbin/postconf', …)` on the xMail document path (`apps/api/src/main.ts:562-591`). Import cycle tooling was not run.

`POST /state/apply` does not require root (`apps/agent/src/server.ts:644-653`). `opts.scope` on `reconcile` is copied onto events (`apps/agent/src/reconciler.ts:1115-1117`); the compile still uses the full snapshot (`:1131-1144`). `triggerReconcile` accepts a scope argument and does not send it (`apps/api/src/server.ts:666-680`). Any enabled principal the API forwards can therefore ask for a host-wide apply. `force` remains root-only.

### 2. Security — C-

Strong pieces, checked in this pass:

- Argon2id PHC encoding and a 1024-byte password ceiling (`apps/api/src/auth.ts:30`, `:36`, `:88`, `:178-188`).
- Session cookie `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` only when the caller passes `secure: true` (`apps/api/src/auth.ts:363-372`).
- Account and root assertions on agent tools (`apps/agent/src/server.ts:323-356`). Shell and files routes call `assertAccountCaller` (`:726`, `:768`).
- Custom-config PUT checks domain ownership before save (`apps/api/src/server.ts:2134-2146`).

Failures are the three P0 items above, plus:

- `GET /host/dkim-probe` runs after `authenticateCaller` and has no role check (`apps/agent/src/server.ts:483-487`).
- `signing.json` is written mode `0644` root:root (`apps/agent/src/services/opendkim-live.ts:161`). The file holds selector, public PEM, and DNS TXT. Private keys are `0600` opendkim:opendkim (`:153`).
- Shell audit stores the raw command (`apps/agent/src/server.ts:742-747`).
- DKIM RSA modulus is 2048 (`apps/agent/src/services/opendkim-live.ts:85-86`). OWASP ASVS 5.0.0 V11.2.3 L2 gives RSA-3072 as the example for about 128-bit security. See the matrix.
- Password minimum is 8 characters (`apps/api/src/auth.ts:178`). No breached-password check exists (search for `hibp` / `pwned` / `breached` found none in product code).
- TOTP is enforced once enrolled (`apps/api/src/server.ts:1034`). Enrollment itself is optional in the account-security surface (`apps/web/src/surfaces/account-security.ts` `data-auth-state="optional"`).
- No `security.txt` (RFC 9116).

SSRF on ACME `directoryUrl` was not re-audited line by line in this pass. Do not treat it as closed.

### 3. Correctness and data integrity — C

Atomic JSON writes fsync the file, rename, and fsync the directory (`packages/state/src/atomic.ts:2-3`, `:65`, `:80`). DNS serials have a real helper, `serialFor` / `bumpSerial`, in `packages/render/src/services/dns.ts:282-285` (YYYYMMDDNN, RFC 1912 section 2.2). The email-auth batch ignores that helper and uses `existingZone.serial + 1` or the constant `2026102201` (`apps/api/src/extended-routes.ts:2569`). The same handler falls back to `203.0.113.10` (TEST-NET-3) when no IPv4 is stored (`:2531-2534`) and interpolates it into SPF (`:2546`).

OpenDKIM retention (P0-2) is also a correctness bug: the signing set is not the desired set.

### 4. Type safety — B

`tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`. `exactOptionalPropertyTypes` is false. `skipLibCheck` is true. One `@ts-expect-error`. Validation is hand-written `fail()` helpers, not a schema library. `tsc` was not executed, so this grade is about the configuration and the casts that were grepped, not a clean compiler run.

### 5. Testing — C

1,909 `it(` calls in 165 test files is a large suite on paper. It was not executed here. The pixel gates call `pixelmatch` with `threshold: 0.1` (`scripts/board-fidelity.mjs:69`), write `report.json`, and `process.exit(1)` only in the `catch` (`:110-113`). A large diff still exits 0. Board HTML is outside the repo (`XP_BOARD_FILE`). Stryker is absent. Critical untested behavior, relative to what the tests can see in CI: the fabricated DKIM batch versus the live OpenDKIM key, and a pixel budget that cannot fail the process.

### 6. Performance and resilience — C+

The agent socket sets request, header, and idle timeouts, an in-flight cap, and destroys the socket when the peer credential is missing (`apps/agent/src/server.ts:1012-1030`). The API xMail path uses synchronous `readFileSync` and `spawnSync` (`apps/api/src/main.ts:562-591`), which blocks the event loop. Event-stream reconnect and backpressure were not re-measured in this pass; earlier reading of `apps/api/src/agent-client.ts` showed a 30s default timeout, reconnect backoff capped at 30s, and a 256KiB pending cap. Those figures were not re-checked line by line for this write-up and are not graded as verified.

### 7. Observability and operations — B-

Audit rows exist for peer denial, shell execution, and custom-config rollback. The shell row stores the command (see security). Health route `/health` is served before caller auth (agent server, around the `/internal/events` split at `:481`). Rollback of a failed custom-config save exists when reconcile returns a failure (`apps/api/src/server.ts:2152-2183`). Release layout and runbooks were not executed.

### 8. Frontend quality — C

Server-rendered HTML, not React. Tokens exist and many shell rules use them. Board-port stylesheets repeat a second palette in raw hex. Logical properties are used widely (`inline-size`, `padding-inline`, `inset-inline-start`) and then defeated by the physical list in the UI lens. Bundle size was not measured (`node_modules` absent). Dead-code tools were not run.

### 9. Maintainability — C

No `TODO` / `FIXME` / `HACK` debt turned up in the earlier source scan (the `XXX` hits were job-id placeholders). The maintainability problem is size and duplication, not comment noise. `jscpd` and `knip` were not run. Docs exist (`ARCHITECTURE.md`, `SECURITY.md`, `STANDARDS.md`, `TESTING.md`) and disagree with the code on radii, shadows, and the 44px target. See the SSOT table.

### 10. Dependencies and supply chain — B-

`pnpm-workspace.yaml` sets `saveExact`, `engineStrict`, `verifyDepsBeforeRun: error`, and `minimumReleaseAge: 1440`. A lockfile is present (`pnpm-lock.yaml`, 2,026 lines). `pnpm audit` was not run, so CVE status is unknown. No SLSA provenance file was found. That is not a claim of SLSA level 0 or 1; the v1.0 requirements page is https://slsa.dev/spec/v1.0/requirements and this tree has no provenance to compare.

### 11. Delivery — C

A workflow exists at `.github/workflows/ci.yml` and was not edited. The owner has disabled Actions. Local gates are `scripts/toolchain.mjs` and `scripts/test-suite.mjs`. Toolchain refuses any Node other than v26.12.1, which is what blocked execution here. Pixel gates do not fail on a diff ratio. Reproducible install is declared (`saveExact`, lockfile) and was not reproduced in this environment.

### 12. AI-change governance — B

No mock DKIM library is imported into production; the fake key is hand-written in the route (P0-1), which is worse than a leaked mock and is scored under security. `artifact-motion.test.ts` locks the raw duration strings, so a later token migration has to fight the test. The pixel gate’s exit path can stay green while the diff grows. No evidence in this pass of a test assertion that was edited to expect the fabricated `p=` value; that search was not exhaustive.

### Build / architecture quality — B-

Same evidence as lens 1. The build is a pnpm workspace with exact engine pins. Layering is documented and then broken by the API package depending on the agent package and by host reads in the API process.

### Cleanliness — B

Source scan found no `TODO`/`FIXME`/`HACK` markers worth a debt list. Board-port is a live second stylesheet, not a temp file. Commented-out blocks were not exhaustively counted.

### Single source of truth — D+

| Concern | Locations that disagree |
|---|---|
| DKIM public key | Live key in `apps/agent/src/services/opendkim-live.ts:155-161`. Fabricated `p=` in `apps/api/src/extended-routes.ts:2547-2548`. Selector `xp…` versus `default._domainkey` |
| SOA serial | `packages/render/src/services/dns.ts:282` (`serialFor`). Constant `2026102201` in `apps/api/src/extended-routes.ts:2502` and `:2569` |
| Fallback mail IPv4 | `203.0.113.10` at `apps/api/src/extended-routes.ts:1030`, `:2486`, `:2534`, `:2910` |
| Type sizes | Role table in `docs/STANDARDS.md:109-114`. Custom properties in `apps/web/src/tokens.ts:689-693`. Raw `11px`, `12px`, `15px`, `22px` in `tokens.ts` and `apps/web/src/board-port/*` (appendix) |
| Color | `:root` tokens through `tokens.ts:680`. 839 later hex/rgb literals, mostly `apps/web/src/board-port/` |
| Radius | Tokens `--xp-radius-sm/md/lg` = 8 / 12 / 14 (`tokens.ts:725-727`). Raw `10px` at `tokens.ts:1147`. Raw `999px` pills in mail layout and board-port |
| Elevation | `--xp-shadow-sm/md/lg` at `tokens.ts:677-679`. Dialog and board-port repeat raw `rgba(16, 24, 40, …)` shadows. `docs/design/artifact-design-system.md` was not re-opened in this pass; do not treat a doc shadow string as verified here |
| Motion | No `--xp-duration` or `--xp-ease`. Literals in `tokens.ts:2584-2691` and `apps/web/src/shell-motion.ts:10`, `:56-57` |
| Focus ring | Global `:focus-visible` at `tokens.ts:815` using focus tokens. Board-port repeats `outline: 2px solid #1D5BD6` (`apps/web/src/board-port/xwhm-dashboard.ts:509`, `xpanel-home.ts:52`, `xmail-inbox.ts:11`, `xmail-compose.ts:11`) |
| Hit target | `--xp-hit-target: 44px` (`tokens.ts:718`) and `docs/STANDARDS.md:119`. Segment radios `38px` (`tokens.ts:1152`). Board-port nav and buttons `min-height: 40px` (see UI lens) |
| Reduced motion | CSS at `tokens.ts:3138`. JS at `shell-motion.ts:9` and `apps/web/src/ws-client.ts:1084` |
| Session cookie name | `HOST_SESSION_COOKIE_NAME` in `apps/api/src/auth.ts:24`. Per-audience name is chosen in `sessionCookieName` (`auth.ts:368`). Both exist on purpose; callers must not import the constant and ignore the audience |
| Reconcile scope | API option dropped (`apps/api/src/server.ts:675-680`). Agent stores it for events only (`apps/agent/src/reconciler.ts:1117`) |

### QA — C

Strategy on paper: unit tests, HTTP tests, typecheck, browser pixel gates, local toolchain script. Coverage percentage was not measured. CI file exists and is not the running gate. Pixel gate does not enforce a budget. Release verification was not performed. Mutation testing is not set up (https://stryker-mutator.io/).

### Code cleanliness — C

Naming is consistent (`xp-` prefix, `fail()` errors, explicit route tables). Function size is the problem: `extended-routes.ts` (4,169) and `server.ts` (3,252) are route catalogs, `tokens.ts` (3,233) is a stylesheet inside a string, `specs.ts` (9,184) is data. Complexity numbers are intentionally absent.

### Balance — C-

God files are listed above. `apps/web/src/board-port/xwhm-dashboard.ts` (1,144) and `xpanel-home.ts` (1,088) own markup, color, and behavior that `tokens.ts` already claims. The agent server (1,196) owns peer auth, every host tool, and the socket server.

### Consistency — C

| Topic | Divergence |
|---|---|
| Error bodies | Agent tools use the shared `fail()` path. API routes mix `fail()`, `{ ok: true, … }`, and domain objects (`extended-routes.ts:2583` returns `{ ok: true, provisioned, count }`). RFC 9457 `problem+json` was not re-verified on every API response in this pass |
| Host execution | Agent uses async `execFile` (`executor.ts:400`). API uses `spawnSync` (`main.ts:588`, and `chown` / `runuser` at `:870` and `:881`) |
| CSS direction | Shell uses logical properties. Active nav, selected mail rows, and meters use physical inset shadows, `text-align: left/right`, `margin-left`, and `translateX` (UI lens) |
| i18n | Surfaces call `t()` / local `text()` helpers. `apps/api/src/mail/document.ts` identity strings were not re-opened in this pass; do not mark them clean |
| Reconcile force | `POST /reconcile` requires root. `POST /state/apply` does not. Custom-config PUT always sends `force: true` and then treats a non-ok reconcile as rollback |
| Motion | CSS animations use raw times. Shell motion uses 160ms / 200ms and a cubic-bezier that no token names |

### Best-practice adherence — C+

| Rule | Source | Result |
|---|---|---|
| `strict` and unchecked index access | https://www.typescriptlang.org/tsconfig/#strict | Pass, with `exactOptionalPropertyTypes: false` |
| Do not put secrets on argv; prefer `execFile` over a shell | https://nodejs.org/en/learn/getting-started/security-best-practices | Pass on the agent executor. Fail on API `spawnSync` of host tools inside a request |
| Argon2id password storage | RFC 9106; OWASP ASVS 5.0.0 V11.4.2 | Pass |
| MFA at L2 | OWASP ASVS 5.0.0 V6.3.3 | Partial. TOTP exists and is optional until enrolled |
| Breached passwords | OWASP ASVS 5.0.0 V6.2.12 | Fail. No check found |
| CSRF | OWASP ASVS 5.0.0 V3.5.1 | Partial. `deriveCsrfToken` exists (`auth.ts:383`). Full route coverage was not re-walked |
| Cross-tenant authz | OWASP ASVS 5.0.0 V8.2.1, V8.4.1 | Partial. Account asserts exist. `/state/apply` still compiles the full snapshot |
| Logical CSS for bidirectional layout | https://www.w3.org/TR/css-logical-1/ and Unicode UAX #9 https://www.unicode.org/reports/tr9/ | Partial. `dir` and `<bdi>` are used. Physical properties remain (24 lines) |
| React rules | https://react.dev/learn | Not applicable. The UI is server-rendered HTML |
| 12-factor config | https://12factor.net/ | Partial. Ports and paths are code constants as well as unit files |
| Review the change, not the author | https://google.github.io/eng-practices/review/reviewer/standard.html | Process is the checklist in `pr-review-checklist.md`. No review metrics were available |
| DORA metrics | https://dora.dev/guides/dora-metrics/ | Not computable. No production deployment history was queried |

### UI code standards — C-

Code-measurable only. Contrast (WCAG 2.2 success criterion 1.4.3), focus obscuring (2.4.11), and visual rhythm are not judged here.

**Token source.** `apps/web/src/tokens.ts:640-730` is the single token block:

- Spacing: 4, 8, 12, 16, 24, 32. All are multiples of 4. `--xp-space-md` is 12, so the scale is a 4pt grid and not an 8pt-only rhythm. `docs/STANDARDS.md:119` describes 8 / 16 / 24 / 32.
- Type roles: 13, 14, 16, 18, 26 (`tokens.ts:689-693`), matching `docs/STANDARDS.md:109-114`. Adjacent ratios are about 1.077, 1.143, 1.125, and 1.444. A major third is 1.25. The golden ratio is about 1.618. `--xp-golden-main: 1.618fr` (`tokens.ts:728`) is a layout track, not a type ratio. The boards do not implement a modular type scale.
- Radii: 8, 12, 14. No elevation tokens beyond the three shadows at `:677-679`. No duration or easing tokens.

**Counts** outside `tokens.ts` lines 1–730, production `apps/web/src/**/*.ts`, tests excluded. Method and every line are in `ui-code-standards-violations-2026-10-24.txt`.

| Measure | Count |
|---|---:|
| Color literals (`#` 6 or 8 digits, `rgb`/`hsl`/`oklch`) | 839 |
| `px` literals | 2,043 |
| of which `1px` hairlines | 212 |
| of which other values not divisible by 4 | 718 |
| CSS `animation` / `transition` lines with a raw time | 5 |
| JS motion durations / easings | `shell-motion.ts:10`, `:56`, `:57` |

Per-file color / px (top of the scan):

| File | Colors | px |
|---|---:|---:|
| `apps/web/src/tokens.ts` (after line 730) | 125 | 506 |
| `apps/web/src/board-port/xmail-compose.ts` | 165 | 359 |
| `apps/web/src/board-port/xpanel-home.ts` | 150 | 369 |
| `apps/web/src/board-port/xwhm-dashboard.ts` | 183 | 307 |
| `apps/web/src/board-port/xmail-inbox.ts` | 143 | 305 |
| `apps/web/src/mail-layout.ts` | 4 | 62 |
| `apps/web/src/arabic-type.ts` | 1 | 36 |

The 718 off-4pt figure includes type sizes (13, 14, 15) and pill radii (`999px`). It is a numeric filter, not a spacing-only defect list. Spacing and radius literals that miss both the token scale and the 4pt grid, verified by opening the line:

- `apps/web/src/tokens.ts:1053` `gap: 18px`
- `apps/web/src/tokens.ts:1057` `font-size: 11px` (no caption role is 11)
- `apps/web/src/tokens.ts:1146` `padding: 3px`
- `apps/web/src/tokens.ts:1147` `border-radius: 10px`
- `apps/web/src/tokens.ts:1152` `min-block-size: 38px` on `[role="radio"]`
- `apps/web/src/mail-layout.ts:68` `padding: 2px 8px` and `border-radius: 999px`
- `apps/web/src/mail-layout.ts:92` raw `#f3f7fe` and `#1d5bd6`

**Durations (complete):**

- `apps/web/src/tokens.ts:2584` `0.9s linear`
- `apps/web/src/tokens.ts:2593` `1.4s ease-in-out`
- `apps/web/src/tokens.ts:2599` `1.4s linear`
- `apps/web/src/tokens.ts:2631` `8s linear`
- `apps/web/src/tokens.ts:2691` `transition: width 0.6s ease` (physical `width`, not `inline-size`)
- `apps/web/src/shell-motion.ts:10` `200` and `160` milliseconds
- `apps/web/src/shell-motion.ts:56-57` `cubic-bezier(0.2, 0.8, 0.2, 1)`

**Focus visible.** One global rule at `apps/web/src/tokens.ts:815`. Extra rules at `:1905` and `:2082-2085`. A repo search for `outline: none` and `outline: 0` in `apps/web/src` found no matches. Board-port repeats the ring with a raw color (files listed in the SSOT table). Grade for WCAG 2.2 success criterion 2.4.7 (Focus Visible, AA, https://www.w3.org/TR/WCAG22/#focus-visible): **Partial**. The indicator exists. It is not a single token, and 2.4.11 (Focus Not Obscured) was not measured.

**`prefers-reduced-motion`.** Present at `apps/web/src/tokens.ts:3138-3143` (`animation`, `transition`, and `scroll-behavior` forced off). `shell-motion.ts:66-67` skips `element.animate` when the media query matches. `ws-client.ts:1084` reads the same query. This is CSS Media Queries Level 5 behavior used to satisfy WCAG 2.2 success criterion 2.2.2 (Pause, Stop, Hide, A) and the intent of 2.3.3 (Animation from Interactions, AAA). Grade: **Pass** for the stylesheet and the shell controller. Board-port inline styles do not add their own motion.

**Logical properties / RTL.** 24 physical-direction lines, all listed in the appendix. The ones that change layout rather than only aligning an LTR isolate:

- `apps/web/src/tokens.ts:1046` and `:1050` — active nav `box-shadow: inset 3px 0` flipped to `-3px` under `html[dir="rtl"]`
- `apps/web/src/mail-layout.ts:92-94` — same pattern, and `:94` also drops the blur spread
- `apps/web/src/board-port/xwhm-dashboard.ts:390` and `:396` — inset `3px` / `-3px` chosen in script
- `apps/web/src/tokens.ts:2699` — `margin-left: auto` on the RTL meter fill
- `apps/web/src/tokens.ts:2565-2566` — `translateX(-100%)` / `translateX(260%)`
- `apps/web/src/shell-motion.ts:51` — `translateX` sign chosen from `style.direction`
- `text-align: left` / `right` pairs: `tokens.ts:1969-1970`, `:2174`, `:2178`, `:2454`, `:3168-3169`, `:3216-3217`; `mail-layout.ts:108-109`, `:126-127`

`dir="ltr"` plus `<bdi>` on identifiers is the right UAX #9 tool. `text-align: right` under RTL on those same isolates fights the isolation (`tokens.ts:2454` is the login case). Grade: **Partial**.

**WCAG 2.2 AA in markup.**

- 1.3.1 Info and Relationships (A) and 4.1.2 Name, Role, Value (A) and 3.3.2 Labels or Instructions (A): https://www.w3.org/TR/WCAG22/#info-and-relationships , https://www.w3.org/TR/WCAG22/#name-role-value , https://www.w3.org/TR/WCAG22/#labels-or-instructions . A line scanner over 226 `input` / `textarea` / `select` / `button` tags (hidden `type=hidden` and `aria-hidden` skipped) flagged 19 lines. Manual reading of all 19 found an accessible name: `label for`, a wrapping `<label>`, or button text on the next source line. Examples that the scanner missed and review accepted: `apps/web/src/board-canvas.ts:27-47`, `apps/web/src/design-board.ts:347`, `apps/web/src/shell.ts:116-117` (visible “Menu”), `apps/web/src/surfaces/xpanel.ts:348-350`, `apps/web/src/surfaces/xwhm.ts:419-425` and `:631-633`. This is **Partial**, not a certified pass. Client DOM built later in `ws-client.ts` was not executed in a browser.
- 2.5.8 Target Size (Minimum), AA, 24×24 CSS pixels: https://www.w3.org/TR/WCAG22/#target-size-minimum . No confirmed pointer target under 24px. The 22px `<kbd>` widgets are `aria-hidden="true"` (`xpanel-home.ts:807`, `xwhm-dashboard.ts:437`). Meter bars at 8px expose `role="meter"` and are not the pointer target (`xwhm-dashboard.ts:479`). The product contract is 44px (`docs/STANDARDS.md:94` and `:119`). That contract is missed, while 2.5.8 is met, at:
  - `apps/web/src/tokens.ts:1151-1152` segment radio `min-block-size: 38px`
  - `apps/web/src/board-port/xwhm-dashboard.ts:389-390` nav `min-height: 40px`
  - `apps/web/src/board-port/xmail-inbox.ts:126-127` and `:567` and `:596`
  - `apps/web/src/board-port/xmail-compose.ts:114-115`
  - `apps/web/src/board-port/xwhm-dashboard.ts:436` search field `min-height: 40px`

UI grade is C- because the token block is real and focus / reduced-motion exist, while most of the board UI does not consume the tokens, the type scale is not modular, and physical properties are still patched per direction.

## Standards conformance matrix

Clause numbers below were checked against a public text or a primary catalogue page. Where the body is paywalled, the row says so and does not invent a subsection.

| Standard | Clause | Requirement | Evidence | Result | Fix |
|---|---|---|---|---|---|
| ISO/IEC 25010:2023 | 3.1.2 Functional correctness | Functions provide the correct results | Fake DKIM `p=` at `extended-routes.ts:2547` | Fail | Publish only `dnsTxt` from `opendkim-live.ts` |
| ISO/IEC 25010:2023 | 3.1.1 Functional completeness | Functions cover the specified tasks | README / STATUS still say no verified capability. Catalog data is large (`specs.ts` 9,184 lines) | Partial | Keep capability claims tied to tested tools |
| ISO/IEC 25010:2023 | 3.2.1 Time behaviour | Response and processing times meet requirements | `spawnSync` on the xMail path, `main.ts:588` | Partial | Move host reads to the agent |
| ISO/IEC 25010:2023 | 3.4.4 User error protection | The product protects users against operation errors | Custom-config rollback when reconcile fails, `server.ts:2152` | Partial | Do not depend on rollback as the only isolation control |
| ISO/IEC 25010:2023 | 3.5+ reliability, security, maintainability, flexibility, safety | Named in the foreword of the preview | Numbered text after 3.4.4 was truncated in the public preview that was opened (https://www.iso.org/standard/78176.html and the iTeh preview PDF). Clause numbers are not guessed | Not scored by clause | Buy the standard before citing 3.5+ |
| ISO/IEC 25023:2016 | measurement functions | Quality measures | Catalogue only: https://www.iso.org/standard/35747.html. Functions were not applied | Not measured | — |
| ISO/IEC 27001:2022 Annex A | 8.4 Access to source code | Source access is controlled | Git repo and `SECURITY.md` exist. Branch protection was not queried | Partial | Record the forge control next to the audit |
| ISO/IEC 27001:2022 Annex A | 8.9 Configuration management | Configurations, including security configurations, are established and maintained | Atomic desired state. Email-auth batch and the include denylist write configurations that do not match the live signer or the isolation claim | Fail | One signer, one serial helper, a parser for includes |
| ISO/IEC 27001:2022 Annex A | 8.13 Information backup | Backups are maintained and tested | Agent backup routes exist (`server.ts` around `:633-640`). Restore was not executed | Partial | Qualify restore in a runbook test |
| ISO/IEC 27001:2022 Annex A | 8.15 Logging | Logs record events that are useful and do not become a second secret store | Peer and shell audits exist. Shell detail includes `command` (`server.ts:746`) | Partial | Store a hash or an allowlisted verb, not the raw command line |
| ISO/IEC 27001:2022 Annex A | 8.24 Use of cryptography | Cryptography is used according to policy | Argon2id is real. DKIM batch cryptography is not. RSA-2048 is below the ASVS 128-bit example | Fail | Delete the hash-as-key path. Decide the RSA size explicitly |
| ISO/IEC 27001:2022 Annex A | 8.25 Secure development life cycle | Rules for secure development exist | `docs/STANDARDS.md`, `SECURITY.md`, tests. The running CI gate is disabled by the owner | Partial | Make the local gate fail on the pixel budget and on this checklist |
| ISO/IEC 27001:2022 Annex A | 8.26 Application security requirements | Security requirements are identified | ASVS L2 is the target this audit was given. Gaps are in this matrix | Partial | Track V6.3.3 and V6.2.12 as requirements |
| ISO/IEC 27001:2022 Annex A | 8.27 Secure system architecture | Engineering principles are established | Privilege split is real and then bypassed by API host reads and the API→agent dependency | Partial | Protocol-only client. No `/etc` reads in the API |
| ISO/IEC 27001:2022 Annex A | 8.28 Secure coding | Secure coding principles are applied | `execFile` argv, peer creds, denylist that does not match `proxy_pass` | Partial | Parser, not a line-start regex |
| ISO/IEC 27001:2022 Annex A | 8.29 Security testing | Security testing is defined and carried out | Large unit suite, not executed here. No SAST config was confirmed | Partial | Run the suite on Node 26 and keep a security test for DKIM ownership |
| ISO/IEC 27002:2022 | guidance under the same control numbers | Implementation guidance | Not opened. Paywalled. Do not cite 27002 subsection numbers from this audit | — | — |
| ISO/IEC/IEEE 29119, 12207, 42010 | — | Test documentation, lifecycle, architecture description | Catalogue pages only. Clause numbers were not verified | Not scored | — |
| ISO/IEC 5055 | four CISQ categories (reliability, security, performance efficiency, maintainability), CWE-based | Automated source measures | Standard text was not opened. Findings below are mapped to CWE names without a Top 25 rank | Not scored as 5055 | https://cwe.mitre.org/top25/archive/2024/2024_cwe_top25.html is the 2024 list; ranks were not copied into this doc |
| OWASP ASVS 5.0.0 | V1.2.5 L1 | OS command injection | Agent `execFile` takes an argv array. Custom includes are not shell, and they are still a config-injection hole | Partial | CSV: https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv |
| OWASP ASVS 5.0.0 | V6.2.1 L1 | Passwords at least 8 characters | `auth.ts:178` | Pass | Raise the product minimum if the policy wants the 15-character recommendation in that same requirement |
| OWASP ASVS 5.0.0 | V6.2.9 L2 | At least 64 characters permitted | Ceiling is 1024 UTF-8 bytes (`auth.ts:30`) | Pass | — |
| OWASP ASVS 5.0.0 | V6.2.12 L2 | Breached-password check | No implementation found | Fail | Add a check that does not log the password |
| OWASP ASVS 5.0.0 | V6.3.3 L2 | MFA | Optional until enrolled | Partial | Require MFA for root and reseller |
| OWASP ASVS 5.0.0 | V11.2.3 L2 | About 128-bit security; CSV example is RSA-3072 | DKIM keys are RSA-2048 | Fail | Document an exception or generate 3072 |
| OWASP ASVS 5.0.0 | V11.4.2 L2 | Password KDF | Argon2id | Pass | — |
| OWASP Top 10 2021 | A02 Cryptographic Failures | https://owasp.org/Top10/2021/A02_2021-Cryptographic_Failures/ | Fabricated DKIM `p=` | Fail | P0-1 |
| OWASP Top 10 2021 | A01 Broken Access Control | https://owasp.org/Top10/2021/A01_2021-Broken_Access_Control/ | `/state/apply` is not root-only; probe route has no role check | Partial | Role-check the probe. Keep apply scoped to the caller’s writes |
| OWASP Top 10 2021 | A03 Injection | https://owasp.org/Top10/2021/A03_2021-Injection/ | Include denylist | Fail (latent include) | P0-3 |
| OWASP Top 10 2021 | A05 Security Misconfiguration | https://owasp.org/Top10/2021/A05_2021-Security_Misconfiguration/ | `signing.json` `0644`; InternalHosts lists customer domains | Fail | P0-2 |
| OWASP Top 10 2021 | A09 Security Logging and Monitoring Failures | https://owasp.org/Top10/2021/A09_2021-Security_Logging_and_Monitoring_Failures/ | Raw shell command in the audit row | Partial | Redact command text |
| CWE | CWE-345 / CWE-347 (authenticity of data) | Insufficient verification of data authenticity | DKIM `p=` is a hash of a string, not a signature key | Fail | Map only. Rank not asserted |
| CWE | CWE-284 Improper Access Control | — | Departed domains remain in SigningTable | Fail | Drop domains absent from the desired set |
| CWE | CWE-94 / CWE-116 Improper neutralization in a config sink | — | Line-anchored denylist | Fail | Parse directives |
| NIST SP 800-218 | PW.1, PW.4, PW.7, PW.8, RV.1 | Secure build, review, and vulnerability response | IDs are the public practice identifiers at https://csrc.nist.gov/pubs/sp/800/218/final. Task sentences were not re-opened for this row | Partial | Treat this checklist as the review record (RV.1). `pnpm audit` still has to be run (PW.8) |
| SLSA v1.0 | Build provenance requirements | https://slsa.dev/spec/v1.0/requirements | No provenance artifact found | Not met | Produce provenance before claiming any level |
| OpenSSF Scorecard | Security-Policy, Pinned-Dependencies, CI-Tests, Fuzzing, SAST | https://github.com/ossf/scorecard/blob/main/docs/checks.md | `SECURITY.md` exists. Dependencies are exact-pinned. A workflow file exists and Actions are disabled. No fuzz or SAST config was confirmed. No numeric score | Mixed, unscored | Run Scorecard rather than estimating it |
| RFC 6376 | 3.6.1 | `p=` is the public key | `extended-routes.ts:2548` | Fail | https://www.rfc-editor.org/rfc/rfc6376#section-3.6.1 |
| RFC 1912 | 2.2 | SOA serial YYYYMMDDNN | Helper exists and the batch route does not use it | Partial | https://www.rfc-editor.org/rfc/rfc1912#section-2.2 |
| RFC 9106 | Argon2id | Password hashing | `auth.ts` | Pass | https://www.rfc-editor.org/rfc/rfc9106 |
| RFC 6238 | TOTP | One-time passwords | Enrollment path exists; not mandatory | Partial | — |
| RFC 9116 | security.txt | A security contact file | Absent | Fail | Add one when a contact exists |
| RFC 7519 / 8725 | JWT | — | No JWT session library found | Not applicable | — |
| WCAG 2.2 | 2.4.7 AA | Focus visible | Global `:focus-visible`, no `outline: none` | Partial | One token for the ring color |
| WCAG 2.2 | 2.5.8 AA | 24×24 CSS px | No confirmed undersized pointer target | Pass | Still meet the 44px product contract |
| WCAG 2.2 | 1.3.1 / 3.3.2 / 4.1.2 | Name, role, label | Scanner plus manual review of 19 flags | Partial | Add a DOM test that fails on an unnamed control |
| WCAG 2.2 | 1.4.3 AA | Contrast | Not measured | Not scored | Separate UX audit |
| Unicode UAX #9 | bidirectional isolates | http://www.unicode.org/reports/tr9/ | `<bdi dir="ltr">` is used. Some of those isolates also set physical `text-align` | Partial | Prefer logical alignment |
| 12-factor | III. Config | https://12factor.net/config | Ports `2083` / `2087` / `2096` live in code (`apps/api/src/entry-points.ts`) and in docs | Partial | One module imported by docs examples |
| Google Engineering Practices | review standard | https://google.github.io/eng-practices/review/reviewer/standard.html | This document is the evidence record | Process | Use `pr-review-checklist.md` |
| Test pyramid / trophy, Stryker | mutation testing | https://stryker-mutator.io/ | Not installed | Fail | Add it only after the suite runs on Node 26 |

RFC 5321/5322, 7208, 7489, 8461, 8460, 3501/9051, 2177, 5465, 1034/1035, 2308, 8555, 8446, 9325, 9110, 9457, 6455, and 6265bis were named in the audit request. This pass verified RFC 6376 §3.6.1, RFC 1912 §2.2, RFC 9106 (Argon2id usage), and the absence of JWT. The other RFCs are implemented or specified somewhere in the catalog and were not conformance-tested here. Do not read a missing row as a pass.

## OSS comparison

No vulnerability counts or install numbers are taken from these projects. The comparison is the privilege shape described by their own docs.

**HestiaCP.** Passwordless sudo is limited to `/usr/local/hestia/bin/*` (https://github.com/hestiacp/hestiacp/blob/main/install/common/sudo/hestiaweb). The CLI helper drops privileges and allowlists commands (https://github.com/hestiacp/hestiacp/blob/main/bin/v-run-cli-cmd). The panel user can still run every script in that directory as root. xPanel’s socket plus `SO_PEERCRED` is a tighter peer check than passwordless sudo of a whole `bin` directory. xPanel then weakens that by letting the API read host files itself.

**Webmin and Virtualmin.** Webmin’s own module-users documentation says the Webmin process runs as root even for restricted module users (https://webmin.com/docs/modules/webmin-users/). Usermin is the path that drops to the user. Virtualmin’s navigation docs describe the same root panel with role restrictions (https://www.virtualmin.com/docs/getting-started/how-to-navigate-in-virtualmin/). xPanel’s unprivileged API process is a clearer boundary than a root panel process. The root agent is still unsandboxed, which is the part that resembles Webmin.

**CyberPanel.** Historical issues describe a root `lscpd` plus sudo model (https://github.com/usmannasir/cyberpanel/issues/1764). A maintainer comment on later hardening was visible in search results and was not re-verified against a 3.0.3 checkout, so this audit does not claim the current CyberPanel terminal design. xPanel should not copy a root panel process.

xPanel is closer to a dedicated root helper than to Hestia’s sudo-all-bin-scripts model, and closer to a split process than to Webmin. The gaps against that design are the unsandboxed agent unit, the API package dependency on `@xpanel/agent`, the API’s own `postconf` and `/etc` reads, and the principal id being a header the API sets after the shared token.

## Findings

### P0

| ID | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|
| P0-1 | `apps/api/src/extended-routes.ts:2547-2563` | DNS TXT that cannot verify DKIM, reported as success | Delete the hash. Write `dnsTxt` from the live signer for domains the caller owns. Reject the call when the signer has no key | Small, one route and its tests |
| P0-2 | `apps/agent/src/services/opendkim-live.ts:116-119`, `:165-172`, `:197-198` | Removed domains stay signed. Customer domains are internal hosts | Rebuild SigningTable from the current desired set only. InternalHosts stays localhost / submission | Small, one writer and a regression test that a removed domain disappears |
| P0-3 | `packages/core/src/rules/custom-config.ts:19`, `:26`; `packages/render/src/system/security-hardening.ts:438-447`; `packages/render/src/edge/nginx.ts:140` | Denylist bypass. Include into nginx is not wired, so remote injection is latent. Root-owned files are still written. Non-root `force: true` rolls back when the agent is up (`apps/api/src/server.ts:2147` vs `apps/agent/src/server.ts:647`) and persists when the agent is down | Parse directives. Deny `proxy_pass`, `alias`, `include`, `root` wherever they appear. Do not include the userdata file until that parser is deny-by-default. Stop sending `force: true` for a non-root save | Medium. Parser plus renderer plus the force flag |

### P1

| ID | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|
| P1-1 | `apps/api/src/main.ts:562-591` | API process blocks on host files and learns mail config it should ask the agent for | Read signing metadata through the agent. Drop `spawnSync` from the request path | Medium |
| P1-2 | `apps/agent/src/server.ts:485-487` | Any enabled principal forwarded by the API can probe OpenDKIM | Require the same role as the mail surface | Small |
| P1-3 | `apps/agent/src/server.ts:644-653`, `apps/agent/src/reconciler.ts:1131-1144`, `apps/api/src/server.ts:675-680` | Apply is host-wide. The API scope argument is discarded | Either require root for apply, or make the reconciler honor a real account scope. Send the scope if it is load-bearing | Medium |
| P1-4 | `apps/agent/src/services/opendkim-live.ts:161` | World-readable signing map | `0640` root:xpanel if the API must not read it directly | Small |
| P1-5 | `apps/api/package.json` dependency `@xpanel/agent` | API build and process can see agent internals | A protocol package with types and no executor | Medium |
| P1-6 | `scripts/board-fidelity.mjs:69`, `:110-113` | Pixel drift does not fail CI or the local gate | `process.exit(1)` when the ratio exceeds a budget | Small |
| P1-7 | `apps/api/src/auth.ts:178`; no breach check; optional TOTP | ASVS L2 authentication gaps | Breach check. MFA required for root and reseller | Medium |
| P1-8 | `apps/api/src/extended-routes.ts:2534`, `:2569` | TEST-NET address and a hardcoded serial can be published | Use `bumpSerial`. Refuse to publish when no real IPv4 is known | Small |
| P1-9 | `apps/agent/src/server.ts:746` | Shell commands, including anything the user pasted, land in the audit database | Store argv0 or a redacted hash | Small |
| P1-10 | `apps/agent/src/main.ts:129-144` and `server.ts:245-250` | In-process agent app does not set `expectedPeerUid`, so a missing peer context is allowed | Pass the API uid into `createAgentApp` even when the socket listener also checks | Small |
| P1-11 | UI counts in the appendix | Two design systems. Magic durations. Physical CSS | Tokenize motion. Port board-port onto `var(--xp-*)`. Replace the physical list | Large |
| P1-12 | No `security.txt` | No machine-readable security contact | Add RFC 9116 file when the contact is real | Small |
| P1-13 | Node 26 required, Node 22 in this environment, Actions disabled | The suite’s greenness is unknown | Run `pnpm test` and `pnpm audit` on 26.12.1 and record the numbers | Environment |

### P2

| ID | Evidence | Impact | Fix |
|---|---|---|---|
| P2-1 | `exactOptionalPropertyTypes: false` in `tsconfig.base.json` | Optional-property bugs slip through | Turn it on per package |
| P2-2 | God files listed in the coverage section | Reviews cannot see a single responsibility | Split route modules and catalog data by domain |
| P2-3 | Segment 38px and board nav 40px versus `--xp-hit-target: 44px` | Product contract miss. WCAG 2.5.8 still holds | Use the token |
| P2-4 | `font-size: 11px` at `tokens.ts:1057` and board-port folder labels | Off the documented type roles | Use `--xp-type-caption` or add an explicit role |
| P2-5 | `artifact-motion.test.ts` asserts raw `translateX` and duration strings | Token migration will look like a test failure | Assert tokens, not the magic numbers |
| P2-6 | No SLSA provenance, Scorecard not run | Supply-chain claim would be unsupported | Generate provenance. Run Scorecard and publish its number |

## Roadmap

These are sequencing buckets, not an estimate of how long a change takes.

**First bucket (the next review cycle).** Remove P0-1 and P0-2. Land the include parser before any nginx `include` of userdata. Stop `spawnSync` on the xMail HTML path. Make the pixel script exit non-zero on a budget. Add `--xp-duration-*` and `--xp-ease-*` and ban new raw times in review. Record a real `pnpm test` / `pnpm audit` run on Node 26.12.1.

**Second bucket.** Split `extended-routes.ts` and the agent tool table by domain. Replace board-port hex with tokens. Convert the 24 physical-direction lines to logical properties or to `bdi` without a physical `text-align`. Require MFA for root and reseller. Add the breached-password check. Set `expectedPeerUid` on the in-process app. Produce a build provenance statement and an actual Scorecard run.

**Third bucket.** Sandbox the root agent (the unit currently has no equivalent of the API’s `ProtectSystem` story; the unit file was not re-opened in this pass, so the sandbox claim stays at “no sandbox equivalent was found in the agent listen path”). Drop the API dependency on the agent package. Decide the type scale in `STANDARDS.md`: either adopt a major-third / golden modular scale, or state that the 13/14/16/18/26 role table is the standard and remove layout-only “golden” naming from type discussions. Add a DOM test for unnamed controls. Add mutation testing on the auth, DKIM, and include-parser modules after the suite is running. Commission the visual UX audit for contrast and focus obscuring; this document does not cover them.

## Grade note

C is a prelaunch grade. The P0 list is enough to keep the NO-GO. Closing P0-1 and P0-2, and making P0-3 deny-by-default before the include is wired, is what moves security. The UI lens does not move the overall grade by itself.
