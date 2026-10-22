# xPanel

An open-source web hosting control panel: **xPanel** for account owners, **xWHM** for root and resellers, and **xMail** for webmail. It is built around strict per-account isolation, configuration files as the source of truth, and a footprint small enough for a 1 vCPU / 1 GB server.

> **Status: prelaunch.** The core libraries in `packages/` are implemented and tested. The API, the reconciler agent, the web interface and the installer are being built next. Do not run xPanel on production servers yet.

## Highlights

- **Isolation per account.** Every account has its own UID, a systemd slice with CPU, memory, process, disk and IO bandwidth/IOPS limits, PHP-FPM pools running as the account inside that slice, and Apache children that serve each host under the owner's UID (`mpm-itk`). Nginx proxies and caches responses but never opens files in account homes.
- **Configuration files are the truth.** Desired state is stored as one file per entity. A reconciler renders a full configuration generation, runs each service's own config test, switches atomically and keeps the previous generation for rollback. The panel's SQLite index can always be rebuilt from the files.
- **Light.** No database server for the panel itself, services are opt-in, idle PHP sites cost no workers (`pm = ondemand`), and the web interface is a static application served by Nginx.
- **Familiar, then better.** Tool groups and names follow what cPanel and WHM users know; the interface adds a quick bar, live job progress, undo, honest "not available" explanations and a full Arabic right-to-left locale.
- **Protection built in.** nftables firewall with a self-lockout guard, Nginx WAF and OWASP CRS support, intrusion detection, two-factor authentication, scoped API tokens and an append-only audit log.
- **Operations.** Side-by-side upgrades with health checks and automatic rollback, transfers between servers, import of cPanel full backups, and support for Ubuntu 22.04/24.04, CentOS Stream 9/10, AlmaLinux and Rocky Linux.

## Repository layout

| Path | Contents |
|---|---|
| `packages/core` | Domain types, error codes, limits, the host-action contract and pure business rules |
| `packages/catalog` | The tool catalog, navigation (every page and the tools it delivers) and translations |
| `packages/os` | Distribution profiles and install plans for `apt` and `dnf` systems |
| `packages/render` | Pure renderers for Nginx, Apache, PHP-FPM, systemd slices, nftables, SSH, DNS, mail, MariaDB, FTP and TLS |
| `packages/db` | Index and operational storage |
| `packages/lifecycle` | Upgrades, backups, transfers and cPanel backup import |
| `docs/` | [Architecture](docs/ARCHITECTURE.md), [engineering standards](docs/STANDARDS.md) and research notes |

## Development

Requirements: Node.js 24 and pnpm 10.

```bash
pnpm install
pnpm test
pnpm typecheck
```

Packages are TypeScript source run directly by Node's type stripping; there is no build step for the libraries. Read [docs/STANDARDS.md](docs/STANDARDS.md) before contributing: it defines the architecture layers, single sources of truth, standards conformance, security and testing rules.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). All contributors sign the [Contributor License Agreement](CLA.md) once.

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not open public issues for security problems.

## License

xPanel is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only). Commercial licensing is available from the maintainer.

## Trademarks

cPanel® and WHM® are registered trademarks of cPanel, L.L.C. aaPanel, CloudLinux, WHMCS, Cloudflare and other product names are trademarks of their respective owners. xPanel is an independent project and is not affiliated with, endorsed by or sponsored by any of them; these names are used only to describe compatibility and migration paths.
