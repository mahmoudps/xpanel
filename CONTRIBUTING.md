# Contributing to xPanel

Thank you for helping build xPanel. The project is prelaunch; contributions must preserve accurate delivery claims as well as working code.

## Before you start

- Read [architecture](docs/ARCHITECTURE.md), [engineering standards](docs/STANDARDS.md) and [current status](docs/STATUS.md).
- For anything larger than a small fix, open an issue first so the approach can be agreed before you write code.
- Report security problems privately through [SECURITY.md](SECURITY.md).

## Setup and verification

Install and activate Node 26.12.1 and pnpm 12.15.0. Their authoritative pins are [.node-version](.node-version) and [package.json](package.json).

```bash
node scripts/toolchain.mjs --check
node scripts/toolchain.mjs pnpm install --frozen-lockfile
node scripts/toolchain.mjs pnpm typecheck
node scripts/toolchain.mjs pnpm test
```

Run these commands from the repository root. The launcher validates existing pinned tools and does not install a runtime or change global tools. TypeScript source uses native type stripping, explicit `.ts` imports and `import type`; avoid enums, namespaces and constructor parameter properties.

Follow [TESTING.md](docs/TESTING.md) for Chromium, synthetic UI and native Linux commands. Missing browser or Linux prerequisites are blocked checks, never passing results. Native tests require a deliberately disposable VM; do not run them on a workstation or a server containing useful workloads.

## What a good change looks like

- **Complete:** update callers, validation, errors, tests and documentation together. Remove replaced code rather than leaving competing implementations or dormant compatibility branches.
- **In the right layer:** keep rules and renderers pure. The API must not execute privileged host commands; the agent owns host side effects through explicit contracts.
- **Authoritative:** import types, schemas, constants and rules from their defining module. Preserve the distinction between desired configuration and identity/security authority.
- **Tested:** cover observable behavior, invalid input, authorization, limits and relevant failure paths. Add positive controls so denial tests cannot pass because all operations are disabled.
- **Secure:** validate boundary inputs and their use as paths, identifiers, unit names or configuration. Use argv arrays and timeouts for external commands. Never commit credentials, state databases or customer data.
- **Bounded:** stream large content, constrain concurrency and response size, and measure changes that affect resource budgets.
- **Accessible:** use translated user-facing text, ASCII digits, keyboard access and correct field alignment in English and Arabic. Verify geometry in a real browser.
- **Honest:** distinguish fixtures, portable execution, real browsers, native Linux and live services. Do not mark a catalog capability verified from a test name or rendered page.

Code, comments, commits and technical documentation use English. User-facing translations may use their target language.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/), for example `fix(core): reject wildcard primary domains`.
- Keep pull requests focused. Explain the concrete behavior change, why it is needed, the verification performed and remaining limits.
- Portable tests and all workspace typechecks must pass. Run additional browser, native or service checks where the change affects their contracts.
- Review dependency changes against the [runtime policy](docs/decisions/runtime.md), including exact pins, lockfile integrity and production exclusions.

## Contributor License Agreement

Before your first pull request can be merged you must agree to the [xPanel Contributor License Agreement](CLA.md). Add this sentence as a comment on your pull request:

> I have read the xPanel Contributor License Agreement and I agree to it.

You only need to do this once. The agreement lets the project keep offering xPanel under the AGPL and under commercial terms; you keep the copyright in your contribution.

## Code of conduct

Everyone taking part in this project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
