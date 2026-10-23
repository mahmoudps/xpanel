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

The output directory must be new. The [login harness](../tests/browser/login-surface-acceptance.mjs) defines 60 states: 3 immutable login audiences, EN/AR, light/dark and widths 320/360/390/768/1440px. It checks compact form visibility, real loaded fonts, text contrast, label/value geometry, touch targets, keyboard behavior and long synthetic error wrapping. The shared [applied-font contract](../tests/browser/applied-font-contract.mjs) uses Chromium CDP glyph observations to verify the actual proportional brand and locale heading faces; a computed stack, available font or fallback does not pass. Its HTTP fixtures reject mutations; they do not authenticate users, bind the public management ports, terminate TLS or prove cookie/CSRF isolation.

The complementary portable HTTP/startup tests exercise actual listener/profile security and startup cleanup:

```bash
node scripts/toolchain.mjs node scripts/test-suite.mjs portable apps/api/src/entry-points-security.test.ts apps/api/src/entrypoint-startup.test.ts
```

These tests cover declared local contracts with disposable stores and fake host execution. External TLS, real firewall visibility, installed service lifecycle and mailbox identity require separate acceptance.

## Navigation and workspace interaction acceptance

```bash
node scripts/toolchain.mjs node tests/browser/navigation-acceptance.mjs --output=test-results/navigation-ui
```

Use a new output directory for every run. This independent suite defines 76 cases. It exercises Forward as well as Back, actual theme and language links, active-route uniqueness, responsive focus return including the 959/960px boundary, long-form scroll, keyboard shortcuts, reduced motion and local interaction timing. The added page-palette cases cover localized filtering, no matches and clearing, complete available-page enumeration, Arrow Up/Down wrapping, Enter navigation, constrained list scrolling, preserved native input/textarea typing and surface-specific shortcut context. They compare the palette with available navigation and require its absence when the catalog exposes no qualified tools.

Final full-suite results must be bound to the exact export. The suite also checks actual text-node edges for a nonempty bounded workspace summary against the unqualified catalog, with explicitly synthetic account data. The existing application and HTTP tests establish their own authentication and ownership assertions; the visual fixture does not authenticate users or execute hosting operations.

Reduced-motion cases retain the normal modal focus requirements. A tiny transition duration is not a substitute for immediate visibility: the focused sheet must already be visible when it receives focus. Keep the preference enabled through opening, trapping, closing and return-focus checks.

The genuine long-scroll cases use the real account-creation form in a shorter 390x600 viewport. They still require more than 100px of actual content overflow and an initial scroll greater than 100px before opening navigation, then verify the observed position after closing. A compact form that fits a taller viewport cannot prove this contract; do not add synthetic padding or skip the precondition.

Typography checks must distinguish font readiness from visual consistency. Inspect the computed role sizes and line heights, Sans brands and ordinary controls, technical-only monospace, consistent field/card spacing and the independent 44px targets. Include English and Arabic, light and dark, mobile and desktop. Loaded font faces alone do not prove consistent type hierarchy or reference parity.

Keep the before-fix failures and their screenshots. Click-to-render samples, document timing, long tasks and layout-shift observations describe this laboratory fixture; they do not establish production INP, capacity or a whole-project completion percentage. Bounded state-read and response-construction changes require a separate controlled before/after measurement with representative data and unchanged security/freshness assertions. Include linked-account, plan and feature-policy changes; account deletion/suspension; lock contention and cross-process consistency. Record real lease/fencing metadata writes rather than claiming that a read projection is write-free. Qualified service snapshots and the inherited R01 consistency gap remain separate. Review these measurements separately from interface acceptance; fixture timings and Windows process RSS do not establish production INP, Linux memory budgets or capacity.

## Mail layout acceptance

```bash
node scripts/toolchain.mjs node tests/browser/mail-layout-acceptance.mjs --output=test-results/mail-layout
```

Use a new repository-relative output directory. The [mail harness](../tests/browser/mail-layout-acceptance.mjs) defines 24 Inbox/Compose states across EN/AR, light/dark and 360/768/1440px. It checks loaded fonts, the actual applied brand/heading glyph faces, responsive pane geometry, actual text edges, mixed English/Arabic input direction, quota glyph order, keyboard landmarks, modal focus, the explicit unavailable transport state and the absence of submission. Source fingerprints and previous failures remain part of the evidence.

The mail renderer displays folder navigation, a message list and one reading pane on wide screens, with an adapted composition editor on smaller screens. Send is disabled and has no form submission or mutation path. Synthetic inbox messages and supplied mailbox observations do not establish mailbox authority, live message selection, draft persistence, SMTP submission or IMAP synchronization. Mailbox authentication and real delivery require separate production-connected acceptance.

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

API regressions use local requests, disposable state/SQLite and declared agent fixtures to check current authority/targets, expected revisions, failed/noop/unknown/malformed replies, global-only acknowledgements and no requested effects on refused deletion/contact-only updates. Database regressions cover linked aliases, unrelated principals and transactional revocation rollback. Table-wrapper tests retain region names, keyboard reachability and header scope with multiple CSS class tokens. These do not qualify live Linux lifecycle behavior.

Neither a safety refusal nor `configuration_applied` with `targetVerified: false` closes account delivery. Retain failed attempts and bind results to the exact exported source.

## Resource meter component acceptance

```bash
node scripts/toolchain.mjs node tests/browser/resource-usage-acceptance.mjs --output=test-results/resource-usage
```

Use a new output directory. The resource harness defines 24 component-preview page views: EN/AR, light/dark, 360/768/1440px and comfortable/compact density. Each view contains 11 supplied meter cases, for 264 component-state observations. It also runs 4 actual-surface renderer diagnostics for unknown reseller usage and known mailbox usage with an unavailable cap. Keep the 28 page outcomes and 264 embedded component states distinct when reporting counts.

Cases cover measured zero, bounded thresholds and over-limit values, explicit unlimited, empty/exceeded zero allocation, unavailable usage/cap and unbounded allocation. Assertions check semantic state, accessible meter attributes, real label/value glyph alignment and compound order, ASCII digits, containment, applied locale heading fonts and automated accessibility. A missing positive cap must not create a fill, percentage or healthy state. The shared technical-value matrix remains separate and uses the updated unavailable IO observation contract.

These are synthetic component and layout observations, not live resource collection, effective kernel limits, quota enforcement, authenticated scale, mail usage or reseller capacity proof. Bind full-suite results to the exact checkout; retain failures and before/after fingerprints.

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

Earlier published and intermediate results apply only to their exact source revisions. Windows-only named-pipe cases can produce different portable totals from Ubuntu. This update adds security, mail-rendering and browser scopes. Use clean-checkout results and the CI run attached to the exact commit. The 60-state login visual, 76-case navigation and 24-state mail harness definitions describe scope, not successful execution or final product acceptance. Test counts are not completion percentages.

For feature or release acceptance, use the [acceptance matrix](planning/ACCEPTANCE-MATRIX.md) and [scenario mapping](planning/acceptance-scenario-mapping.json). Record commands, timestamps, source/artifact identity, environment, outcome, observed effects and cleanup. Missing harnesses and prerequisites remain open. Security, real services, authenticated scale, recovery and the 30-60 day pilot are separate production gates described in [STATUS.md](STATUS.md).

## Safe reports

Do not place real passwords, MFA enrollment material, tokens, private keys, session cookies, databases or customer content in reports, screenshots or public CI artifacts. Review the content before uploading it. Use isolated synthetic fixtures, redact sensitive failure output and keep previous run outcomes intact.
