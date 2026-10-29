# xPanel engineering standards

These standards define the quality bar for changes. [Architecture](ARCHITECTURE.md) explains the system structure; [status](STATUS.md) distinguishes implemented code from qualified product behavior. Requirements below are not claims that every existing path already meets them.

## Prelaunch changes

xPanel has not launched. Replace superseded code and update its callers in one coherent change. Do not retain dormant compatibility shims, competing implementations or versioned API branches without a demonstrated need. Unreleased schema changes must account for existing installations and recovery; prelaunch status does not authorize silent data loss.

The product's upgrade and rollback functions require their own acceptance. Repository cleanup is not a substitute for safe customer migration behavior.

## Architecture and authority

- Domain rules in `packages/core` and renderers in `packages/render` remain pure. Keep platform names and distribution behavior in `packages/os`.
- The API validates requests, enforces authority and orchestrates desired state. Privileged host execution belongs to `apps/agent` through explicit contracts; no local executor fallback in the API.
- Use `packages/state` for desired hosting configuration and `packages/db` for authoritative identity/security, durable operational data and derived indexes. Reindexing must never pretend to restore credentials, MFA or revocations.
- Lifecycle orchestration uses injected ports. Every production entry point must supply real implementations and report unavailable execution explicitly.
- Import the authoritative schema, type, constant or rule. Do not copy validation logic or derive trust from client-supplied ownership, role, path or identifier fields.
- Make cross-process claims, leases, UID allocation and state/identity changes durable and crash-safe. A process-local mutex or single-file rename does not prove a complete transaction.

The [authorization matrix](planning/authorization-route-matrix.json) and [acceptance matrix](planning/ACCEPTANCE-MATRIX.md) must remain consistent with actual callers and tests.

## Resource targets

The control plane targets a 1 vCPU / 1 GB server. These are acceptance budgets, not current measured guarantees:

| Component | Target |
|---|---|
| API | At most 60 MB idle RSS and less than 0.5% idle CPU |
| Agent | At most 50 MB idle RSS and less than 0.5% idle CPU |
| Browser | At most 200 KB gzip initial JavaScript and 60 KB gzip per route chunk |
| Panel installation | At most 200 MB, excluding distribution hosting services |

SQLite memory belongs to the processes that use it and must be included in their measurements. The current UI is server-rendered inside the API, with inline assets and browser clients; measure the actual document and assets rather than assuming a static frontend or existing route splitting.

- Bound concurrency, queues, list sizes, cache entries, command runtime and WebSocket buffering.
- Stream archives, logs, uploads and downloads; prove peak memory and cancellation for large inputs.
- Use indexed filters and cursor pagination with representative data. Avoid full snapshots or directory walks on authenticated hot paths unless bounded and measured.
- Specify retention and archive behavior for metrics, sessions, jobs, audit and event history.
- Record hardware, OS, dataset, warm-up, duration, throughput, p50/p95/p99, failures, RSS, CPU and source/artifact identity. Test 10/100/500 load levels on declared profiles; do not imply 500 active users fit the minimum profile.
- Keep optional services opt-in and idle workers bounded. Measure before changing the architecture or adding a dependency.

## Code and dependencies

- Use the exact versions in [.node-version](../.node-version), [package.json](../package.json) and [pnpm-lock.yaml](../pnpm-lock.yaml). Follow the [runtime policy](decisions/runtime.md).
- TypeScript runs through Node native type stripping. Use explicit `.ts` imports and `import type`; avoid unsupported emit-dependent syntax.
- Use English identifiers, comments, technical documentation and source strings. Translate user-facing text through shared catalogs.
- Keep errors stable and typed. Preserve denial and failure distinctions without exposing internal paths, commands, secrets or raw backend errors.
- Prefer small functions and existing platform features. Explain non-obvious constraints and tradeoffs in comments.
- Ship complete behavior and remove dead or replaced paths. Do not substitute placeholder data, fake success or swallowed errors for a missing implementation.
- Pin direct dependencies, review licenses and integrity, and update manifests and lockfile together. Keep runtime dependencies permissively licensed and development-only exceptions isolated as documented in the runtime decision.

## Security requirements

- Validate at request boundaries and again where input becomes a path, SQL identifier, unit name, configuration line or host action. Reject invalid input; do not silently transform it into a different authorized target.
- Use argv arrays, explicit executable paths and timeouts. Never interpolate untrusted data into shell strings.
- Authenticate principals from authoritative state. Enforce scope, ownership, reseller ACL, feature policy and suspension on every read, mutation and event channel, including before HTML hydration.
- Keep the API unprivileged, service credentials protected and kernel peer identity verified. A valid shared credential alone does not authorize an arbitrary process.
- Confine tenant file operations with the account identity and kernel path controls. Require real helper availability, cgroup/quota enforcement and race/failure tests; no unrestricted root fallback.
- Preserve Argon2id, session lifetime controls, CSRF, persistent lockout, MFA and atomic credential/session/token revocation. Production root authentication must meet its accepted MFA policy.
- Never place secrets in source, URLs, browser assets, logs or audit details. Redaction must cover nested structures and failure paths.
- Treat proxy headers as untrusted unless the ingress is authenticated and the exact public Host/origin matches the immutable listener profile. Preserve audience-bound session credential hashes and CSRF, role/route confinement and required mutation Origin checks. Secure cookie names alone do not isolate ports; Bearer tokens must not authenticate the interactive UI profiles. Qualify public TLS, backend exposure and renewal behavior on the actual deployment.
- Reserve public management ports `2083/2087/2096` and private loopback listeners `12083/12087/12096` from tenant forwards, proxy upstreams and web backends. A legacy firewall/API environment needs an explicit reviewed additive migration; no background auto-opening or silent environment replacement is permitted.
- Audit intent and outcome durably. Prove failure behavior under disk exhaustion, crash and recovery; an optional log path or successful DB insert is not an end-to-end append-only guarantee.

## Protocol and quality targets

| Area | Target reference |
|---|---|
| HTTP and problem details | RFC 9110 and RFC 9457 |
| Time and locales | RFC 3339 timestamps, UTC storage, BCP 47 language tags |
| Passwords and second factors | Argon2id, RFC 9106; TOTP, RFC 6238 |
| Sessions and API tokens | Secure/HttpOnly/SameSite cookie policy, CSRF defenses and RFC 6750 bearer-token handling |
| ACME and DNS | RFC 8555, DNS/IDNA/CAA rules appropriate to the feature |
| Mail | SMTP/IMAP and SPF/DKIM/DMARC standards appropriate to the feature |
| Accessibility | WCAG 2.2 AA |
| Product quality | Security, reliability, performance, usability and maintainability acceptance |

References are implementation targets, not certification. Protocol support requires interoperability and negative testing against actual services. Keep generated API descriptions aligned with executable schemas; do not claim complete OpenAPI coverage without verifying it.

## Testing and evidence

- Test observable behavior, boundaries, authorization, failure recovery and resource limits. Use independent positive and negative controls.
- Keep portable, HTTP, browser, native Linux and external-service evidence separate. Fakes are useful when clearly identified; they cannot establish real host behavior.
- A missing prerequisite, skipped test, absent harness or failed cleanup leaves the relevant gate open. Do not rewrite earlier failures as successful runs.
- Bind evidence to source and artifact hashes, command, runtime, environment, timestamp, observed effects and cleanup. Verify the exact release rather than a nearby source revision.
- Keep catalog stages evidence-based: `researched`, `implemented`, `integrated`, `verified`, `out-of-scope`. Production navigation admits only qualifying verified capabilities.
- Check actual data, effective identities, service responses and failure outcomes. A dashboard status, successful render, HTTP 200 or command string is not a sufficient oracle.

See [TESTING.md](TESTING.md) for executable commands.

## UI and internationalization

- Translate through the shared catalogs, not inline language pairs. Supported languages come from one registry (`packages/core/src/i18n/locales.ts`: BCP 47 tag, endonym, direction, ISO 15924 script). UI copy is written once as English source text in ICU MessageFormat (`{name}`, `plural`, `select`) and translated in gettext PO catalogs (`apps/web/src/locales/<tag>.po`; catalog names in `packages/catalog/src/locales/<tag>.po`), with `msgctxt` where one source text needs different translations. Server code uses `translator(locale)`; browser bindings use the page translator `xpT`; stored messages are marked with `msgid`/`msgctxt`. Direction, script-specific typography and language switchers derive from the registry, never from a comparison with a language code. A page's language is `?lang=` when it names a supported locale, then the saved preference, then `Accept-Language` (RFC 4647 lookup), then English. Adding a language means a registry entry and its PO files; `node scripts/i18n-catalog.mjs pot` writes the template and `check` reports missing or unused messages.
- Support English and Arabic as maintained locales with appropriate direction and logical layout. Keep all displayed digits ASCII `0-9`, including dates, references, percentages and interpolated values.
- Align values directly beneath their labels on the same field edge. Isolate LTR values inside Arabic fields without moving them to the opposite edge. Measure actual browser geometry on desktop and mobile; extend the same contract to print and exported documents.
- Use meaningful labels, accessible names, visible focus, keyboard navigation, contrast and touch targets of at least 44 px where required by the interface contract.
- Dialogs and modal navigation must manage focus, Escape, Tab/Shift+Tab loops, background interaction and focus return. Test native disclosure controls and collapsed content. Reduced-motion styles must make a modal visible before focus entry; disable transitions and animations rather than leaving a tiny visibility-transition window.
- Show loading, empty, unavailable, error and no-permission states truthfully. Confirm consequential actions and display server-reported outcomes. Keep dedicated login screens compact, with the essential form visible on small screens and a server-selected surface identity.
- Preserve selected language, theme, density and authorized account context through document navigation, Back/Forward and reload. Test focus return across the `959/960px` shell breakpoint, keyboard shortcuts, long-form scroll and reduced-motion behavior. Laboratory timing samples do not establish production INP or capacity.
- Page search lists all currently available authorized destinations, with localized filtering, a clear no-match state, Arrow Up/Down selection and Enter navigation. It does not execute arbitrary commands, invent actions or add unavailable capabilities. Keep its list scroll bounded and retain native editing inside inputs and textareas.
- Mail rendering must distinguish observations from usable operations. Keep Send disabled and non-submitting until the production delivery contract is connected and qualified; an inbox layout alone does not establish mailbox authentication, SMTP or IMAP.
- Never invent account context, generation numbers, references or successful service outcomes in the browser. User-facing public references must come from their authoritative persisted allocator.
- Do not claim offline readiness while required fonts or assets remain external. Observe loaded font faces and network failures during acceptance.

### Typography and spacing roles

Use IBM Plex Sans for English interface text and IBM Plex Sans Arabic for Arabic interface text. Noto Sans Arabic remains an allowed fallback face, not the Arabic UI face. Keep ordinary navigation, labels, buttons, headings and values in the interface family. The sign-in xPanel, xWHM and xMail wordmarks and the reference mail header wordmark use IBM Plex Mono. This explicit wordmark exception does not extend to ordinary interface text or headings. Otherwise reserve IBM Plex Mono for code, commands, file paths and technical identifiers; tabular numbers do not by themselves require a monospace family.

| Role | Font size | Latin line height | Arabic line height |
|---|---|---|---|
| Caption | 13px | 20px | 22px |
| Label | 14px | 22px | 24px |
| Body and ordinary controls | 16px | 24px | 26px |
| Card heading | 18px | 28px | 30px |
| Page heading | 26px | 34px | 36px |
| Mobile input | 16px | 24px | 24px |

Arabic uses additional vertical room for its glyphs; Latin and Arabic line heights are not identical. The dedicated wordmarks retain their product typography; their Mono exception does not change the proportional font or line-height requirements for ordinary interface text and headings.

The primary layout rhythm uses 8px between a label and its value, 16px between fields, 24px between groups or within desktop cards, and 32px between larger sections. Phone cards use 16px padding. Utility icon spacing is separate from form/group rhythm. Generic controls retain at least 44px height; login inputs use 48px.

Keep the 44px minimum interaction target independently of the text line height. Use shared field/card/section spacing roles and consistent alignment; do not compensate for inconsistent typography with isolated offsets or unrelated gaps. Verify computed font family, loaded font faces, role sizes, line heights, logical edges and clipping in the actual browser. Defined roles are a contract, not a claim that every screen has passed visual acceptance.

### Account actions and table access

Keep dialogs bound to the persisted internal account target while displaying its username/domain for confirmation. Exact confirmation, Escape/focus return, disabled pending inputs, cleared passwords and single-flight submission are required. Unknown outcomes require review before retry, not a success toast or automatic second request. Global acknowledgement with `targetVerified: false` must remain verification-required.

Account writes require current-target authorization. Contact-email-only PATCH synchronizes the account and contact index with compensating rollback on index failure. Deletion refuses with HTTP 412 before changes when target-bound purge is unavailable; after an advertised purge contract is accepted, failure can return HTTP 503 with verification required and retained terminating state. These source contracts do not qualify native purge or production availability. Failures must preserve recovery evidence and must not imply completed native lifecycle effects. Tables require scoped headers and named keyboard-reachable scroll regions even when wrappers have multiple CSS classes.

## Release acceptance

Changes require appropriate tests, workspace typechecks, updated documentation and delivery evidence. Feature exposure additionally requires its acceptance gate; package-level green tests alone are insufficient.

Releases require verified artifacts, protected runtime paths, reproducible dependencies/native builds, a supported-environment matrix, consistent backups, tested failure/rollback procedures and measured service health. Review [runbooks](operations/runbooks.md) against actual commands before execution. Production approval also requires authenticated performance, security/recovery qualification and a measured pilot, as tracked in [STATUS.md](STATUS.md).
