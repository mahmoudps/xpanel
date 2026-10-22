# xPanel

xPanel is an open-source web hosting control panel in development, with **xPanel** for account owners, **xWHM** for root and resellers, and **xMail** for mailbox users.

**Status: prelaunch, not production qualified.** The project contains authentication, authorization, configuration rendering, reconciliation, native isolation primitives and lifecycle libraries. These do not yet form a qualified replacement for a production hosting panel. The capability catalog currently has **0 verified capabilities**. See [current status](docs/STATUS.md) for the implemented foundations, evidence limits and remaining work.

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

The recorded development baseline has 2332 portable tests, typechecks for all 10 workspace projects, 6 real Chromium application scenarios and 18 synthetic UI states exercised in Chromium. Those layers have different scopes. They do not establish live service behavior, full route coverage, authenticated scale, disaster recovery or production readiness. See [testing](docs/TESTING.md) for reproducible commands and limitations.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). All contributors sign the [Contributor License Agreement](CLA.md) once. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not open public issues for security problems.

## License

xPanel is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only). Commercial licensing is available from the maintainer.

## Trademarks

cPanel® and WHM® are registered trademarks of cPanel, L.L.C. aaPanel, CloudLinux, WHMCS, Cloudflare and other product names are trademarks of their respective owners. xPanel is an independent project and is not affiliated with, endorsed by or sponsored by any of them; these names are used only to describe compatibility and migration paths.
