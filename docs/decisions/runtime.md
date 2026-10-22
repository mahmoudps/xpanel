# Runtime and dependency policy

Date: 2026-10-22. This decision records the tested workspace pins. It does not assert that a pinned version remains the newest upstream release indefinitely.

## Runtime contract

Use stable releases with exact, reviewed pins. Prerelease, nightly, beta and release-candidate versions are excluded. The current tested environment is:

| Component | Pin |
|---|---|
| Node.js | 26.12.1 |
| pnpm | 12.15.0 |
| TypeScript | 7.0.2 |
| Node.js types | 26.6.5 |
| Vitest | 5.0.5 |
| WebSocket library | ws 8.22.0 |
| WebSocket types | 8.18.2 |
| Browser harness | @playwright/test 1.64.1 |
| Accessibility test engine | axe-core 4.14.0 |
| Release import parser | es-module-lexer 3.0.4 |

The exact runtime is in [.node-version](../../.node-version); [package.json](../../package.json) defines the engine range and package-manager pin. [pnpm-workspace.yaml](../../pnpm-workspace.yaml) centralizes exact catalog entries and installation controls; [pnpm-lock.yaml](../../pnpm-lock.yaml) records resolved packages and integrity values. These files take precedence over a stale version table.

TypeScript source runs directly with Node native type stripping. Relative imports end in `.ts`, and code avoids syntax that requires emitted JavaScript transformations. TypeScript 7 uses its supported compiler executable; scripts must not assume an older JavaScript compiler implementation path.

## Workspace launcher

From the repository root:

```bash
node scripts/toolchain.mjs --check
node scripts/toolchain.mjs pnpm install --frozen-lockfile
node scripts/toolchain.mjs pnpm typecheck
node scripts/toolchain.mjs pnpm test
```

[The launcher](../../scripts/toolchain.mjs) selects already installed exact Node/pnpm executables from its supported local locations or PATH, checks their versions and passes argv without a shell. It does not download tools or change global installations. Run it from this checkout's root. Installation fixtures and alternate checkouts must use their own explicit executables and working directory; they must not accidentally operate on another workspace.

## Dependency controls

- Commit manifests and lockfile together. Use frozen installs; do not repair a failed installation by silently replacing versions or the lockfile.
- `engineStrict` rejects unsupported runtimes. `verifyDepsBeforeRun: error` prevents silent dependency repair during a run.
- Keep the 1440-minute package-release cooldown. Existing exact exceptions for the reviewed Rolldown 1.2.15 release family do not exempt future versions or unrelated packages.
- Build scripts are denied by default. The current exact permission is `esbuild@0.28.2`; it does not authorize arbitrary lifecycle scripts or later versions.
- Keep Node types on the single exact catalog entry. The narrow `@types/tar-stream>@types/node` override addresses that dependency's wildcard type range rather than overriding all package behavior.
- Runtime dependencies must meet the permissive-license policy. The existing development-only Lightning CSS 1.33.0 and axe-core 4.14.0 MPL-2.0 exceptions remain restricted to the test toolchain. They are not runtime permissions or legal certification.
- es-module-lexer is an exact MIT-licensed development dependency used to verify release import closure. It is not a production application dependency.

## Updating a pin

1. Verify the actual stable version against official release metadata, excluding prereleases. Check release age, platform availability, integrity, license and known advisories.
2. Update exact manifests/catalog references and lockfile together. Preserve narrowly scoped installation controls.
3. Verify runtime distribution checksums and package integrity/signatures where available. Metadata or a provenance field alone is not proof of independent attestation verification.
4. Run frozen development installation, workspace typechecks and portable tests. Repeat relevant real-browser and native/Linux checks for changed contracts.
5. Install production dependencies into a new isolated directory with the exact native package manager, `--prod --frozen-lockfile` and reviewed script policy. Verify the unchanged lockfile, installed inventory and platform-native modules.
6. Confirm the release artifact excludes development tools, caches, credentials and unsupported platform binaries. Bind results to the tested source and artifact identity.

Use official distribution/registry metadata for version discovery: [Node.js releases](https://nodejs.org/dist/index.json), [pnpm](https://registry.npmjs.org/pnpm/latest), [TypeScript](https://registry.npmjs.org/typescript/latest) and each dependency's official registry entry. Repeat discovery for each update; this document is a pinning policy, not a rolling upstream-version feed.

## Verification boundaries

A successful dependency install, advisory check or browser launch establishes only that specific result. Development checks do not qualify native production installation, host isolation, live services or recovery. Production-only dependency installation and a signed/integrity-checked source archive are separate from installation/reboot and service acceptance. See [testing](../TESTING.md) and [status](../STATUS.md).
