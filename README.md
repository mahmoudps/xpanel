# xPanel

xPanel is an open-source web hosting control panel in development, with **xPanel** for account owners, **xWHM** for root and resellers, and **xMail** for account users. Mailbox-specific authentication and live mail service acceptance remain open.

**Status: prelaunch, NO-GO for production. No accepted completion percentage is asserted.** The project contains authentication, authorization, configuration rendering, reconciliation, native isolation primitives and lifecycle libraries. These do not yet form a qualified replacement for a production hosting panel. The capability catalog currently has **0 verified capabilities**. See [current status](docs/STATUS.md) for the implemented foundations, evidence limits and remaining work.

## Design goals

- Account workloads run under separate identities and resource limits, with independently tested boundaries between tenants.
- Desired hosting configuration is stored in entity files. SQLite separately holds authoritative identity and security records, operational data and derived indexes; it requires consistent backups.
- An unprivileged API handles HTTP and server-rendered UI. A separate privileged agent performs host operations through explicit contracts.
- Optional hosting services and a small control-plane footprint target resource-constrained servers. A 1 vCPU / 1 GB profile is a qualification target, not an established capacity guarantee.
- English and Arabic interfaces preserve keyboard access, field alignment and ASCII digits. A visible route or rendered screen is not proof that its hosting operation works.
- Capabilities enter production navigation only after their source, artifact, environment and acceptance evidence meet the delivery contract.

## Repository layout

The workspace contains 7 libraries and 3 applications:

| Path | Responsibility |
|---|---|
| `packages/core` | Domain types, errors, limits, host-action contracts and pure rules |
| `packages/catalog` | Capability definitions, translations, navigation metadata and delivery assessment |
| `packages/os` | Distribution profiles, package names and installation plans |
| `packages/render` | Pure renderers for web, PHP, systemd, firewall, DNS, mail and other service configuration |
| `packages/state` | Desired-state schemas, atomic file storage and generation snapshots |
| `packages/db` | SQLite identity, sessions, MFA, tokens, operational records and derived indexes |
| `packages/lifecycle` | Backup, restore, transfer, upgrade and cPanel import logic with injected ports |
| `apps/api` | HTTP, authentication, authorization, WebSocket and application orchestration |
| `apps/agent` | Privileged reconciliation, host executors, service adapters and confined file operations |
| `apps/web` | HTML rendering, navigation, authentication clients, styles and translations |

See [architecture](docs/ARCHITECTURE.md) and [engineering standards](docs/STANDARDS.md).

## Development

Use **Node 26.12.1** and **pnpm 12.15.0**, as pinned in [.node-version](.node-version) and [package.json](package.json). Install and activate those versions before running:

```bash
node scripts/toolchain.mjs --check
node scripts/toolchain.mjs pnpm install --frozen-lockfile
node scripts/toolchain.mjs pnpm typecheck
node scripts/toolchain.mjs pnpm test
```

TypeScript source runs through Node's native type stripping; relative imports use `.ts`. Native helper compilation and browser installation have separate prerequisites. The launcher checks existing tools; it does not install them.

The test layers distinguish portable rules/HTTP behavior, workspace type checking, 6 application-browser scenarios, 18 synthetic workspace states, a 60-state login visual matrix, a separate 76-case navigation matrix and 24 mail-layout states. Counts describe harness scope; final results must be recorded against the exact published checkout. They do not establish live service behavior, full route coverage, authenticated scale, disaster recovery or production readiness. See [testing](docs/TESTING.md) for reproducible commands and limitations.

The application entrypoint starts one unprivileged process with three immutable profiles behind separate HTTPS ingress: xPanel on `2083`, xWHM on `2087`, and xMail on `2096`. Their private HTTP listeners use loopback ports `12083`, `12087`, and `12096`. Each profile has a compact independent login, exact HTTPS origin and audience-bound session/CSRF checks. Public TLS termination and existing-installation migration are operator tasks; see the [ingress configuration guide](deploy/nginx/README.md). xMail currently uses the account control-plane identity, not a mailbox identity.

An authenticated read-only workspace summary can display authorized account/plan fields while hosting tools remain unavailable. The page palette filters every currently available destination for the authorized surface, with Arrow Up/Down selection, Enter navigation and Escape focus return. It lists pages only; it does not grant tool authority or execute commands.

The mail renderer uses a folder column, message list and reading pane, with a responsive composition workspace. Send is explicitly disabled and does not submit while live delivery remains unqualified. Mailbox authentication, service wiring and end-to-end delivery remain open.

Seven new administrative destinations separate navigation metadata only; they are not implemented screens or delivered service capabilities.

## Account workflow boundaries

The account UI has a compact 5-column list, one scoped action dialog and a bounded creation form. JSON requests, explicit confirmation, keyboard/focus handling and verification-required feedback are tested independently. The production catalog still has 0 verified capabilities; synthetic fixtures enable these screens for tests and do not make every tool available in production.

Account DELETE currently returns HTTP 412 after current-target authorization and exact username confirmation, without purging account state or deleting its identity. Contact-email-only PATCH also returns 412 before effects until a qualified metadata/index writer exists. Other successful configuration acknowledgements report global scope with `targetVerified: false`; they do not prove that the requested account hosting workload is working. Unknown or failed outcomes require review before retrying. Native account lifecycle, service and recovery acceptance remain open.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). All contributors sign the [Contributor License Agreement](CLA.md) once. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not open public issues for security problems.

## License

xPanel is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only). Commercial licensing is available from the maintainer.

## Trademarks

cPanel® and WHM® are registered trademarks of cPanel, L.L.C. aaPanel, CloudLinux, WHMCS, Cloudflare and other product names are trademarks of their respective owners. xPanel is an independent project and is not affiliated with, endorsed by or sponsored by any of them; these names are used only to describe compatibility and migration paths.
