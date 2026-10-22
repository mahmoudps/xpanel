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

The [application harness](../tests/browser/acceptance.mjs) starts a local [fixture](../tests/browser/fixture.mjs) and runs 6 selected scenarios. It exercises authentication, root bootstrap/MFA, account scope, assets/surfaces and bilingual behavior in a real browser. The host executor is explicitly fake; this is not a live hosting-service test. It records page errors; the synthetic UI harness below additionally observes console errors.

The default result is `test-results/browser/browser-results.json`. Set `XPANEL_BROWSER_OUTPUT` to a new directory when retaining multiple runs. Results include runtime and selected source fingerprints. Fixtures use test credentials; do not replace them with production credentials or point them at an existing deployment.

## Synthetic UI acceptance in Chromium

After installing Chromium, run:

```bash
node scripts/toolchain.mjs node tests/browser/phase1-acceptance.mjs --output=test-results/phase1-ui
```

The output directory **must not already exist**. Use a new suffix for each rerun, such as `test-results/phase1-ui-run2`; retain previous failures and their screenshots.

The [UI harness](../tests/browser/phase1-acceptance.mjs) uses a [synthetic visual fixture](../tests/browser/visual-fixture.mjs), real renderers and real Chromium. Its 18 balanced English/Arabic light/dark states cover 9 selected routes at 360/768/1440px. It checks navigation, context and history, mobile menus, keyboard/focus loops, disclosures, actual field edges, LTR isolation and font readiness. It writes results, screenshots and before/after source fingerprints into the requested directory.

External font requests are part of the current readiness measurement. Network restrictions or unavailable fonts may fail the check; this suite is not an offline-readiness promise. It does not submit hosting mutations, qualify every route, prove live authorization/service behavior, or measure INP, CLS or capacity. Synthetic account/mail data are marked as fixtures and do not promote catalog capabilities.

## Native Linux tests

Native tests are privileged and may create accounts, groups, systemd resources, mounts, quota filesystems and firewall fixtures. Use only an explicitly disposable native Linux VM with no customer data, useful workloads or shared state. Do not set the acknowledgement on a workstation, shared container, WSL session or production server. The runner does not invoke sudo or provision a missing VM for you.

Inside the prepared disposable VM, as root, the current primitive preflight expects Ubuntu 24.04, booted systemd, cgroup v2 controllers and the commands checked by [test-linux-preflight.mjs](../scripts/test-linux-preflight.mjs). Review those exact checks and fixture cleanup before proceeding.

```bash
export XPANEL_TEST_DISPOSABLE_VM=I_ACCEPT_DESTRUCTIVE_TESTS_IN_THIS_DISPOSABLE_VM
node scripts/toolchain.mjs pnpm test:linux --preflight
node scripts/toolchain.mjs pnpm test:linux
```

The acknowledgement is not proof that the environment is suitable. Snapshot the VM first, inspect collisions, verify the source/archive identity before privileged execution and record cleanup afterward. Native helpers require the appropriate compiler and system prerequisites. A passing primitive, peer-identity or file-helper test does not qualify Apache/PHP workloads, installation/reboot or unrelated services.

## Exit status and release interpretation

The [suite runner](../scripts/test-suite.mjs) separates portable, unit, HTTP, browser and Linux layers. Browser/Linux preflight exits with status `2` when blocked; ordinary failures use a nonzero result. Portable output explicitly reports that browser and Linux checks were not run. `pnpm test:all` still requires the independent browser and disposable-Linux prerequisites; it is not a portable substitute.

The recorded development baseline is 2332/2332 portable tests in 110 files, 10 passing workspace typechecks, 6/6 application-browser scenarios and 18/18 synthetic UI states. Re-run the exact published checkout before attaching those results to it. Test counts are not completion percentages.

For feature or release acceptance, use the [acceptance matrix](planning/ACCEPTANCE-MATRIX.md) and [scenario mapping](planning/acceptance-scenario-mapping.json). Record commands, timestamps, source/artifact identity, environment, outcome, observed effects and cleanup. Missing harnesses and prerequisites remain open. Security, real services, authenticated scale, recovery and the 30-60 day pilot are separate production gates described in [STATUS.md](STATUS.md).

## Safe reports

Do not place real passwords, MFA enrollment material, tokens, private keys, session cookies, databases or customer content in reports, screenshots or public CI artifacts. Review the content before uploading it. Use isolated synthetic fixtures, redact sensitive failure output and keep previous run outcomes intact.
