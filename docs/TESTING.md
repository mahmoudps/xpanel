# Testing xPanel

Run commands from the repository root using Node 26.12.1 and pnpm 12.15.0. [.node-version](../.node-version), [package.json](../package.json) and [pnpm-lock.yaml](../pnpm-lock.yaml) identify the required environment. Install and activate those versions before starting; the launcher validates existing executables and does not download tools.

## Portable tests and type checking

```bash
node scripts/toolchain.mjs --check
node scripts/toolchain.mjs pnpm install --frozen-lockfile
node scripts/toolchain.mjs pnpm typecheck
node scripts/toolchain.mjs pnpm test
```

The portable layer includes unit tests and request/loopback HTTP tests while excluding native Linux fixtures. Some host executors and lifecycle ports are fakes. Passing portable tests proves their asserted behavior, not real hosting services or kernel workload isolation.

For a narrower layer or a focused regression:

```bash
node scripts/toolchain.mjs pnpm test:unit
node scripts/toolchain.mjs pnpm test:http
node scripts/toolchain.mjs node scripts/test-suite.mjs portable apps/api/src/main-security.test.ts
```

Use Vitest arguments through the portable runner to record machine-readable results:

```bash
node scripts/toolchain.mjs pnpm test --reporter=json --outputFile=test-results/portable.json
```

Create the output parent directory first if required by your reporting setup. Keep results separate per run and do not overwrite a failed run when recording a retry.

## Complete browser partitions

CI runs the same browser acceptance inventory in 3 isolated partitions. Each partition runs its commands serially; at most 3 CI machines run in parallel. The original required Chromium check remains an aggregate gate. It requires every partition to succeed and validates all command receipts against the same source, manifest, runtime, platform and run ID. Missing, cancelled, failed, duplicate or incomplete evidence cannot pass. The original 18 commands remain; 8 workspace regressions (forwarding, email filters, files, account contact, domains, databases, mail folders and mail contacts) bring the inventory to 26.

Inspect coverage without launching browsers:

```bash
node scripts/toolchain.mjs node scripts/browser-acceptance-runner.mjs --validate
node scripts/toolchain.mjs node scripts/browser-acceptance-runner.mjs --list
```

For a complete local run, use a fresh run ID and run the partitions sequentially on a shared workstation:

```bash
node scripts/toolchain.mjs node scripts/browser-acceptance-runner.mjs --shard=1/3 --run-id=local-001
node scripts/toolchain.mjs node scripts/browser-acceptance-runner.mjs --shard=2/3 --run-id=local-001
node scripts/toolchain.mjs node scripts/browser-acceptance-runner.mjs --shard=3/3 --run-id=local-001
node scripts/toolchain.mjs node scripts/browser-acceptance-runner.mjs --aggregate=test-results/browser-acceptance-local-001 --run-id=local-001
```

Outputs are separated by partition and command. Existing output directories are not overwritten. Temporary fixture directories are isolated and removed after each partition. CI transfers only the small partition receipts to the aggregate job; it does not cache authenticated browser state. Frozen dependency installation and Chromium system prerequisites remain mandatory. Partitioning does not establish a new CI wall time until measured on the actual workflow; receipt durations separate command execution from external queue latency.
## Real Chromium application acceptance

Install matching Chromium into the cache used by the harness. In a POSIX shell:

```bash
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.tools/playwright-browsers"
node scripts/toolchain.mjs pnpm exec playwright install chromium
node scripts/toolchain.mjs pnpm test:browser --preflight
node scripts/toolchain.mjs pnpm test:browser
```

In PowerShell, set the same cache before those commands:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.tools/playwright-browsers'
node scripts/toolchain.mjs pnpm exec playwright install chromium
node scripts/toolchain.mjs pnpm test:browser --preflight
node scripts/toolchain.mjs pnpm test:browser
```

Chromium also needs its platform libraries. On a Linux development or CI machine, provision those libraries explicitly according to Playwright's requirements; browser preflight reports an unavailable browser as blocked. Do not infer application acceptance from a successful browser download or an `about:blank` launch.

The [application harness](../tests/browser/acceptance.mjs) starts a local [fixture](../tests/browser/fixture.mjs) and runs 6 selected scenarios. It exercises authentication, root bootstrap/MFA, account scope, assets/surfaces and bilingual behavior in a real browser. It uses the test server contract rather than qualifying the three public HTTPS ingress listeners. The host executor is explicitly fake; this is not a live hosting-service test. It records page errors; the synthetic UI harness below additionally observes console errors.

The default result is `test-results/browser/browser-results.json`. Set `XPANEL_BROWSER_OUTPUT` to a new directory when retaining multiple runs. Results include runtime and selected source fingerprints. Fixtures use test credentials; do not replace them with production credentials or point them at an existing deployment.

## Synthetic UI acceptance in Chromium

After installing Chromium, run:

```bash
node scripts/toolchain.mjs node tests/browser/phase1-acceptance.mjs --output=test-results/phase1-ui
```

The output directory **must not already exist**. Use a new suffix for each rerun, such as `test-results/phase1-ui-run2`; retain previous failures and their screenshots.

The [UI harness](../tests/browser/phase1-acceptance.mjs) uses a [synthetic visual fixture](../tests/browser/visual-fixture.mjs), real renderers and real Chromium. Its 18 balanced English/Arabic light/dark states cover 9 selected routes at 360/768/1440px. It checks selected navigation, context and Back behavior, mobile menus, keyboard/focus loops, disclosures, field edges and LTR isolation. It records font readiness observations; those observations alone are not a font-readiness acceptance assertion. It writes results, screenshots and before/after source fingerprints into the requested directory.

External font requests are part of the current readiness measurement. Network restrictions or unavailable fonts may fail the check; this suite is not an offline-readiness promise. It does not submit hosting mutations, qualify every route, prove live authorization/service behavior, or measure INP, CLS or capacity. Synthetic account/mail data are marked as fixtures and do not promote catalog capabilities.

## Independent login visual acceptance

```bash
node scripts/toolchain.mjs node tests/browser/login-surface-acceptance.mjs --output=test-results/login-visual
```

The output directory must be new. The [login harness](../tests/browser/login-surface-acceptance.mjs) defines 60 states: 3 immutable login audiences, EN/AR, light/dark and widths 320/360/390/768/1440px. It checks compact form visibility, real loaded fonts, text contrast, label/value geometry, touch targets, keyboard behavior and long synthetic error wrapping. The shared [applied-font contract](../tests/browser/applied-font-contract.mjs) uses Chromium CDP glyph observations to verify the dedicated Mono wordmark and proportional locale heading faces; a computed stack, available font or fallback does not pass. Its HTTP fixtures reject mutations; they do not authenticate users, bind the public management ports, terminate TLS or prove cookie/CSRF isolation.

The complementary portable HTTP/startup tests exercise actual listener/profile security and startup cleanup:

```bash
node scripts/toolchain.mjs node scripts/test-suite.mjs portable apps/api/src/entry-points-security.test.ts apps/api/src/entrypoint-startup.test.ts
```

These tests cover declared local contracts with disposable stores and fake host execution. External TLS, real firewall visibility, installed service lifecycle and mailbox identity require separate acceptance.

## Navigation and workspace interaction acceptance

```bash
node scripts/toolchain.mjs node tests/browser/navigation-acceptance.mjs --output=test-results/navigation-ui
```

Use a new output directory for every run. This independent suite defines 88 cases. It exercises Forward as well as Back, actual theme and language links, active-route uniqueness, responsive focus return including the 959/960px boundary, long-form scroll, keyboard shortcuts, reduced motion and local interaction timing. The page-palette cases cover localized filtering, no matches and clearing, complete available-page enumeration, Arrow Up/Down wrapping, Enter navigation, constrained list scrolling, preserved native input/textarea typing and surface-specific shortcut context. They compare the palette with the authorized navigation in each fixture, including its unqualified state. Audit cases additionally measure actual field, group and card spacing and desktop header/value glyph edges.

Final full-suite results must be bound to the exact export. The suite also checks actual text-node edges for a nonempty bounded workspace summary against the unqualified catalog, with explicitly synthetic account data. The existing application and HTTP tests establish their own authentication and ownership assertions; the visual fixture does not authenticate users or execute hosting operations.

Reduced-motion cases retain the normal modal focus requirements. A tiny transition duration is not a substitute for immediate visibility: the focused sheet must already be visible when it receives focus. Keep the preference enabled through opening, trapping, closing and return-focus checks.

The genuine long-scroll cases use the real account-creation form in a shorter 390x600 viewport. They still require more than 100px of actual content overflow and an initial scroll greater than 100px before opening navigation, then verify the observed position after closing. A compact form that fits a taller viewport cannot prove this contract; do not add synthetic padding or skip the precondition.

Typography checks must distinguish font readiness from visual consistency. Inspect the computed role sizes and line heights, proportional ordinary controls, the narrowly defined Mono wordmarks, technical monospace, consistent field/card spacing and the independent 44px targets. Include English and Arabic, light and dark, mobile and desktop. Loaded font faces alone do not prove consistent type hierarchy or reference parity.

## Registered views and current management workflows

```bash
node scripts/toolchain.mjs node tests/browser/mfa-runtime-acceptance.mjs --output=test-results/mfa-runtime
node scripts/toolchain.mjs node tests/browser/composed-acceptance.mjs --output=test-results/composed
node scripts/toolchain.mjs node tests/browser/native-workflows-acceptance.mjs --output=test-results/native-workflows
node scripts/toolchain.mjs node tests/browser/extensions-acceptance.mjs --output=test-results/extensions
```

Each output directory must be new. These runners define 8 development-disabled MFA presentation states, 472 registered-route states, 12 native management workflow states and 112 extension states. They retain before/after source fingerprints, bounded representative/failure screenshots and complete case results. Insufficient disk headroom leaves unexecuted cases pending; it never turns them into passes or skips.

The management and extension fixtures use dark phone and light desktop states in English and Arabic. They do not cover the inverse theme/viewport pairs. MFA uses light sign-in and security pages. The registered-route matrix retains the reverse-proxy destination's actual disabled role boundary rather than granting owner access to root-only aaPanel tools. Unread collections require an unread state without invented rows or values. Exact typography roles follow [STANDARDS.md](STANDARDS.md); captions, labels, human values and technical content remain distinct.

The current inbox's separate Chromium regression drives the real WebSocket dispatcher and rendered board with synthetic mailbox data:

```bash
XPANEL_REQUIRE_BROWSER_TESTS=1 node scripts/toolchain.mjs pnpm exec vitest run apps/web/src/xmail-live-refresh.test.ts --maxWorkers=1
```

CI sets this flag so an unavailable browser fails instead of silently skipping the regression. The four English/Arabic phone/desktop states check read-only refresh, preserved selection/query/filter, invalidation coalescing, undo and truthful failure states. Authentication, sealed mailbox authority, factor persistence and development-to-production session behavior remain separate HTTP tests. Synthetic browser success cannot qualify hosting operations, SMTP delivery, IMAP service deployment or native lifecycle execution.

Keep the before-fix failures and their screenshots. Click-to-render samples, document timing, long tasks and layout-shift observations describe this laboratory fixture; they do not establish production INP, capacity or a whole-project completion percentage. Bounded state-read and response-construction changes require a separate controlled before/after measurement with representative data and unchanged security/freshness assertions. Include linked-account, plan and feature-policy changes; account deletion/suspension; lock contention and cross-process consistency. Record real lease/fencing metadata writes rather than claiming that a read projection is write-free. Qualified service snapshots and the inherited R01 consistency gap remain separate. Review these measurements separately from interface acceptance; fixture timings and Windows process RSS do not establish production INP, Linux memory budgets or capacity.

## Mail layout acceptance

```bash
node scripts/toolchain.mjs node tests/browser/mail-layout-acceptance.mjs --output=test-results/mail-layout
```

Use a new repository-relative output directory. The [mail harness](../tests/browser/mail-layout-acceptance.mjs) defines 24 Inbox/Compose states across EN/AR, light/dark and 360/768/1440px. It checks loaded fonts, the actual applied brand/heading glyph faces, responsive pane geometry, actual text edges, mixed English/Arabic input direction, quota glyph order, keyboard landmarks and modal focus. The fixture exposes an enabled explicit Send button without a native sending form. The harness never clicks Send, checks that Enter in composition does not submit and rejects mutation requests. Source fingerprints and previous failures remain part of the evidence.

The mail renderer displays folder navigation, a message list and one reading pane on wide screens, with an adapted composition editor on smaller screens. The product Send client calls `POST /api/webmail/send`, validates the acknowledgement and preserves the draft on refused or uncertain outcomes. Focused client and HTTP tests exercise that contract with synthetic transports; they remain separate from this layout runner. Synthetic inbox messages and supplied mailbox observations do not establish installed mailbox authority, draft persistence, SMTP submission or IMAP synchronization. Actual SMTP/IMAP behavior and recipient delivery require separate native and external-observer acceptance.

## Account interaction and mutation acceptance

```bash
node scripts/toolchain.mjs node tests/browser/accounts-acceptance.mjs --output=test-results/accounts-ui
```

The [accounts harness](../tests/browser/accounts-acceptance.mjs) defines 24 list/action-dialog and creation states across EN/AR, light/dark and 360/768/1440px. It uses actual renderers and Chromium with synthetic JSON responses. It checks the 5-column account list, 640px maximum creation measure, actual custom interface heading/dialog fonts, 8px label/value gaps, logical glyph edges, 44px targets, exact confirmation, keyboard/focus return, single-flight requests and preserved pending identity.

A delayed synthetic creation acknowledgement remains verification-required and locks the pending identity. Synthetic 409 unknown outcomes prevent immediate retry. A 412 deletion refusal keeps the row and shows an unavailable state. This fixture does not authenticate production accounts or perform native creation, suspension, purge or recovery.

Run complementary current-source regressions separately or through the full portable layer:

```bash
node scripts/toolchain.mjs node scripts/test-suite.mjs portable \
  apps/web/src/accounts-actions.test.ts apps/web/src/table-regions.test.ts \
  apps/api/src/account-mutation-security.test.ts \
  packages/db/src/repos/account-access-security.test.ts
```

API regressions use local requests, disposable state/SQLite and declared agent fixtures to check current authority/targets, expected revisions, failed/noop/unknown/malformed replies and global-only acknowledgements. The [target-bound regression](../apps/api/src/contact-delete-target-security.test.ts) separately covers refusal before effects without a purge contract, retained terminating state on purge failure and identity removal only after a positive fixture purge reply. Contact-only updates exercise metadata/index writes and compensating rollback. Database regressions cover linked aliases, unrelated principals and transactional revocation rollback. Table-wrapper tests retain region names, keyboard reachability and header scope with multiple CSS class tokens. These do not qualify live Linux lifecycle behavior.

Neither a safety refusal nor `configuration_applied` with `targetVerified: false` closes account delivery. Retain failed attempts and bind results to the exact exported source.

## Resource meter component acceptance

```bash
node scripts/toolchain.mjs node tests/browser/resource-usage-acceptance.mjs --output=test-results/resource-usage
```

Use a new output directory. The resource harness defines 24 component-preview page views: EN/AR, light/dark, 360/768/1440px and comfortable/compact density. Each view contains 11 supplied meter cases, for 264 component-state observations. It also runs 4 actual-surface renderer diagnostics for unknown reseller usage and known mailbox usage with an unavailable cap. Keep the 28 page outcomes and 264 embedded component states distinct when reporting counts.

Cases cover measured zero, bounded thresholds and over-limit values, explicit unlimited, empty/exceeded zero allocation, unavailable usage/cap and unbounded allocation. Assertions check semantic state, accessible meter attributes, real label/value glyph alignment and compound order, ASCII digits, containment, applied locale heading fonts and automated accessibility. A missing positive cap must not create a fill, percentage or healthy state. The shared technical-value matrix remains separate and uses the updated unavailable IO observation contract.

These are synthetic component and layout observations, not live resource collection, effective kernel limits, quota enforcement, authenticated scale, mail usage or reseller capacity proof. Bind full-suite results to the exact checkout; retain failures and before/after fingerprints.

## Browser form-control states

```bash
node scripts/toolchain.mjs node tests/browser/native-control-states-acceptance.mjs --output=test-results/native-control-states
```

Use a new output directory. The harness checks workspace input/select/help states, English/Arabic alignment, disabled/read-only behavior, keyboard focus and forced-colors adaptation. It also captures each login audience to check that workspace selectors stay scoped. Native browser controls here are unrelated to privileged Linux helpers. External applied-font assertions remain required; this is not offline or cross-browser qualification.

## Advisory account IP allocation

```bash
node scripts/toolchain.mjs node tests/browser/ip-allocation-acceptance.mjs --output=test-results/ip-allocation
```

Use a new output directory. Synthetic API replies exercise shared defaults, dedicated choices, preview failure, request races/cancellation and refused or uncertain submission outcomes. Portable router/state cases separately cover authorization, plan entitlement, allocation conflicts and preservation of legacy reservations. Preview is read-only and advisory; commit revalidates under the writer lease. No browser fixture or configuration acknowledgement proves network-interface binding or live provisioning.

## Native Linux tests

Native tests are privileged and may create accounts, groups, systemd resources, mounts, quota filesystems and firewall fixtures. Use only an explicitly disposable native Linux VM with no customer data, useful workloads or shared state. Do not set the acknowledgement on a workstation, shared container, WSL session or production server. The runner does not invoke sudo or provision a missing VM for you.

Inside the prepared disposable VM, as root, the current primitive preflight expects Ubuntu 24.04, booted systemd, cgroup v2 controllers and the commands checked by [test-linux-preflight.mjs](../scripts/test-linux-preflight.mjs). Review those exact checks and fixture cleanup before proceeding.

```bash
export XPANEL_TEST_DISPOSABLE_VM=I_ACCEPT_DESTRUCTIVE_TESTS_IN_THIS_DISPOSABLE_VM
node scripts/toolchain.mjs pnpm test:linux --preflight
node scripts/toolchain.mjs pnpm test:linux
```

Snapshot qualification binds both the approved archive SHA-256 and the independently approved source SHA-256. Supply `--snapshot-sha256` and `--source-sha256` to the executor and agent-boundary qualifiers using coordinator-provided values. A receipt self-hash alone does not establish provenance. Receipt verification must match the source-bound package-manager pin and the actual extracted tree; a stored marker or a hash copied from the same untrusted receipt is insufficient.

The extraction/install verifier has a distinct command contract:

```bash
node scripts/vm/verify-source-snapshot.mjs \
  --archive='<REVIEWED_ARCHIVE>' --manifest='<REVIEWED_MANIFEST>' \
  --expected-archive-sha256='<APPROVED_ARCHIVE_SHA256>' \
  --expected-source-sha256='<INDEPENDENT_APPROVED_SOURCE_SHA256>' \
  --destination='<NEW_TRUSTED_EXTRACTION_DIRECTORY>' \
  --pnpm-path='<ABSOLUTE_REVIEWED_PNPM_EXECUTABLE_OR_CJS_MJS>'
```

Replace every placeholder with independently reviewed values before use. `--pnpm-path` selects only the trusted extraction/frozen-install tool; it is not an executor or agent-boundary qualifier flag. It must be absolute and outside the extracted snapshot. The verifier requires the snapshot's exact Node and pnpm pins, launches a JavaScript CLI with the pinned Node directly or a native executable without a shell shim, and rejects a wrong version. It binds archive/source/manifest hashes, exact extracted files, lockfile and the resulting install receipt. Extraction/frozen-install evidence may run outside a native Linux VM; it does not establish native qualification or waive the disposable-VM preflight for privileged qualifiers.

The acknowledgement is not proof that the environment is suitable. Snapshot the VM first, inspect collisions, verify the source/archive identity before privileged execution and record cleanup afterward. Native helpers require the appropriate compiler and system prerequisites. A passing primitive, peer-identity or file-helper test does not qualify Apache/PHP workloads, installation/reboot or unrelated services.

## Exit status and release interpretation

The [suite runner](../scripts/test-suite.mjs) separates portable, unit, HTTP, browser and Linux layers. Browser/Linux preflight exits with status `2` when blocked; ordinary failures use a nonzero result. Portable output explicitly reports that browser and Linux checks were not run. `pnpm test:all` still requires the independent browser and disposable-Linux prerequisites; it is not a portable substitute.

Earlier published and intermediate results apply only to their exact source revisions. Windows-only named-pipe cases can produce different portable totals from Ubuntu. This update adds security, mail-rendering and browser scopes. Use clean-checkout results and the CI run attached to the exact commit. The 60-state login visual, 88-case navigation and 24-state mail harness definitions describe scope, not successful execution or final product acceptance. Test counts are not completion percentages.

For feature or release acceptance, use the [acceptance matrix](planning/ACCEPTANCE-MATRIX.md) and [scenario mapping](planning/acceptance-scenario-mapping.json). Record commands, timestamps, source/artifact identity, environment, outcome, observed effects and cleanup. Missing harnesses and prerequisites remain open. Security, real services, authenticated scale, recovery and the 30-60 day pilot are separate production gates described in [STATUS.md](STATUS.md).

## Safe reports

Do not place real passwords, MFA enrollment material, tokens, private keys, session cookies, databases or customer content in reports, screenshots or public CI artifacts. Review the content before uploading it. Use isolated synthetic fixtures, redact sensitive failure output and keep previous run outcomes intact.

## Email filter configuration

The account filter workspace manages account-wide and individual mailbox configuration through `/api/mail/filters`. Selected reads return a context-bound revision and an explicit `configuration_only` application state. PATCH, DELETE and reorder require the current `expectedRevision`; create checks it when supplied. Reorder accepts the exact selected ID set. Account-wide and mailbox feature permissions are checked separately, alongside existing tenant, reseller and token boundaries. The xMail listener's API confinement is unchanged.

Run the affected checks with the pinned runtime and one test worker during iteration:

```bash
node scripts/test-suite.mjs portable apps/api/src/mail/filter-validation.test.ts apps/api/src/completion-security-email-filters.test.ts --maxWorkers=1
node scripts/test-suite.mjs unit apps/web/src/account-filters-client.test.ts apps/web/src/board-port/extensions/account-filters.test.ts scripts/test-browser-acceptance.test.ts --maxWorkers=1
node scripts/toolchain.mjs node tests/browser/completion-email-filters.mjs
```

The browser harness exercises the actual renderer, client and confirmation dialogs in English and Arabic on desktop and phone. Its session/HTTP transport is simulated explicitly; API authorization is tested separately with isolated HTTP fixtures. It checks stale edits, uncertain writes, account/scope response binding, malformed saved configuration, preview escaping, action ordering and actual field/card geometry. The canonical browser manifest includes this harness in its required partition inventory.

Saved Sieve previews are bounded, validated serialization. They do not prove native parser acceptance, installation, activation or message delivery. Native Sieve/forwarding activation, delivery, mixed-expression editing, multiple actions, PCRE and execution tracing remain open; none is qualified by these portable or browser fixtures. Retain the full release and native-service gates above.
## File workspace request and result boundaries

The existing file workspace uses `POST /api/accounts/:username/files`. List, read, list-trash and get-bytes require file read authority; mutations retain file write authority. POST session CSRF remains required. The API validates operation fields and bounds, rechecks credentials and the current account before transport, and validates bounded agent replies against the captured path and operation. Agent diagnostics are not copied into browser errors. Disconnected services are refused before dispatch; uncertain dispatched mutations require explicit current-state review.

The browser controller preserves browse, edit, save, upload, download, create, folder and trash operations under one state owner. File and directory generations prevent late replies from replacing a newer selection or draft. Create and upload use `overwrite:false`. Saves compare a fresh read with the opened baseline, validate the exact acknowledgement and read back the submitted text before reporting success. This is not atomic conditional writing: another writer can change a file between the pre-read and write. Atomic external-writer exclusion and native filesystem qualification remain open.

Focused iteration commands:

```bash
node scripts/test-suite.mjs portable apps/api/src/file-workspace-validation.test.ts apps/api/src/completion-file-workspace-security.test.ts --maxWorkers=1
node scripts/test-suite.mjs unit apps/web/src/file-workspace-client.test.ts scripts/test-browser-acceptance.test.ts --maxWorkers=1
node scripts/toolchain.mjs node tests/browser/completion-file-workspace.mjs
```

The browser harness uses the real renderer, client and dialogs with explicitly simulated session/file RPC. It covers English/Arabic phone/desktop behavior, stale reads, dirty navigation, captured targets, refusal/uncertainty/readback, bounds, existing operations and applicable geometry. Code contents retain LTR direction and whitespace; ordinary translated form fields retain their RTL alignment. The canonical required browser partition includes this harness. These results do not prove actual jailed UID/GID execution, descriptor confinement, kernel quotas, native operations, recovery or complete reference parity. Keep the disposable Linux qualification and full release gates separate.

## Account contact metadata

`GET/PATCH /api/account/preferences` derives its account from the authenticated active hosting owner. It accepts no account selectors or unrelated settings. Tokens require `account-preferences:read` or `account-preferences:write`; account feature checks, listener confinement, session CSRF and current authorization remain required. Administrative account PATCH retains its existing permissions.

PATCH requires the current contact representation tag. This fixed projection includes account ID, canonical contact email, plan, owner, status and creation time. It is current-value CAS: changing those values away and back restores the same tag. It is not a monotonic counter or an authorization grant. Email validation preserves local-part case and never trims the submitted address.

Contact writes recheck authorization and the tag under the StateStore writer lease, then synchronize the derived contact/search index before committing authority. Synchronous compensation restores the exact account-file preimage and target index/search rows under that lease. Failed restoration retains recovery evidence and reports an uncertain outcome. The SQL checkpoint is in-process; this does not establish durable cross-store crash recovery. Post-commit audit failures report changed state requiring verification. Review flags take precedence over an unchanged-contact receipt.

```bash
node scripts/test-suite.mjs portable packages/core/src/account-contact.test.ts packages/state/src/account-contact.test.ts packages/db/src/repos/account-contact-checkpoint.test.ts packages/db/src/sql-runner-metadata.test.ts apps/api/src/completion-account-contact-security.test.ts --maxWorkers=1
node scripts/test-suite.mjs unit apps/web/src/account-contact-client.test.ts apps/web/src/board-port/extensions/account-contact.test.ts scripts/test-browser-acceptance.test.ts --maxWorkers=1
node scripts/toolchain.mjs node tests/browser/completion-account-contact.mjs
```

The browser acceptance uses real rendering and client code with simulated session/API transport in English and Arabic, on phone and desktop. It checks account binding, draft preservation, stale/uncertain saves, explicit reload and applicable geometry. It is part of the required browser partition inventory. Contact metadata does not verify an email address, change login or MFA, provision mail, or demonstrate delivery. Full release, native-service and recovery gates remain separate.

## Test lanes

The existing `test`, `test:unit`, `test:http`, `test:linux`, `test:browser` and `test:all` commands retain their existing environment selection. In particular, required repository merge checks are not changed by lane filtering. Those legacy names do not certify that every test is a pure unit test.

- `pnpm test:fast --affected=scripts/test-lane-budget.test.ts` runs the listed affected tests first, then the complete portable set excluding `slow`. Repeat `--affected` for more paths. The combined run must stay below 300 s. Arbitrary file or tag filters are rejected so a partial run cannot be labeled complete.
- `pnpm test:full` requires a clean commit and an explicitly acknowledged disposable native Linux fixture. It runs nonvisual portable and Linux tests, including slow cases, using the pinned Node `node:sqlite` production engine. A missing native prerequisite is blocked, not passed. Use one source-bound full result per candidate rather than repeating it for reassurance.
- `pnpm test:release` requires a clean commit and runs tagged computed visual cases plus the existing Chromium acceptance. It does not rerun technical suites or deploy anything. Comprehensive visual, long-flow, property and load coverage must remain explicit in release acceptance; this entry point does not claim unregistered scenarios exist.
- `pnpm test:census` is a measurement command for establishing the initial slow budget. It runs the complete portable selection with no file/tag filters, records every expanded case with actual tags and durations, module wall times, framework outcomes and before/after source identity. It permits an unestablished cap solely to collect this inventory. A completed census reports `measurement_only` and exits `2`, never a lane pass, qualification or cap approval. A failed/interrupted framework or changed source remains a failure. Review the measured slow cases, rebuild their expensive state, then measure the rebuilt candidate before proposing the initial caps.

`--preflight` checks the relevant environment without running test suites. Browser preflight launches the pinned browser to establish availability only.

Classify pure, database-free logic as `unit` (under 100 ms), one application behavior with isolated state as `feature` (under 1 s), and a complete business flow as `journey` plus `slow`. `visual` requires `slow`. Any observed case at 2000 ms or more must be rebuilt and tagged, with at most one journey per flow. Existing unclassified cases are not silently treated as pure units.

The named runtime budget check uses Vitest's actual expanded case metadata, including skipped, parameterized, factory-generated and fast-filtered cases. It records its own measured duration. Focused pure unit tests cover an over-budget filtered inventory and framework failure status. This avoids using a static source parser as an expanded-case count. The portable and native slow caps live in `scripts/test-slow-budget.mjs`; both are deliberately `null` until the complete rebuilt inventory is measured and reviewed. No cap of 3 has been adopted. Explicit lanes report blocked before suites while their required budget is unestablished. Once established, caps must shrink as fixtures improve; increases require approval.

Lane receipts include the versioned executable-input source fingerprint, commit/tree, lockfile digest, pinned Node and SQLite versions, and before/after source stability. This executable-input algorithm is distinct from the browser runner's full Git inventory algorithm; their digests cannot be substituted for one another. Preflight records free disk, memory and load; under 1% free workspace disk blocks heavy lanes. An available disk alone does not establish an exclusive heavy-lane slot or adequate memory/load.

The acceptance map is a source traceability inventory. `node scripts/acceptance-coverage.mjs` validates all 60 scenarios, 6 fault classes and their supporting test declaration anchors; it does not execute or accept a scenario. Supporting in-process/storage fixtures use `environment: null` where they do not meet the matrix's U/H/B/V/E definition. Node-rendered HTML is not browser evidence, request adapters are not real loopback HTTP, and a native test declaration is not a native pass. Every scenario retains explicit remaining gaps and unaccepted status.

Keep expensive immutable state once per class. Restore database state with a transaction per test where compatible; use prebuilt production-engine snapshots when independent connections or real concurrency require it. Running full migrations per ordinary test is not the target architecture. Tests touching concurrency, migration or durability must keep those real guarantees.

Run one heavy job at a time. Check disk/load first, run jobs expected to exceed 2 min under an owned background supervisor and retain process-retirement evidence. The runner does not force-kill only its direct child at the wall budget, which could leak workers; it reports an over-budget run as failed and lists slow cases for rebuild. Skipped or blocked prerequisites remain distinct from passes. Deployment smoke checks and final visual acceptance are separate operations.
