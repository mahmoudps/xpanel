# xPanel engineering standards

The binding quality bar for every change, human or agent. The design lives in [ARCHITECTURE.md](ARCHITECTURE.md); this file says how it is built. When the two disagree, raise it — do not pick silently.

## Prelaunch policy (standing order)

xPanel has not launched. All code is first-version code with no released versions to stay compatible with. Every change is a complete cutover: replace the old code outright and update every caller in the same change. No shims, compatibility adapters, deprecated paths, old/new feature flags, dual implementations, versioned API prefixes or patch-style fixes. The single init migration is edited in place. This policy ends with the first public release.

The product's own upgrade-with-rollback capability is still built: it serves future customers, it is not a licence to keep compatibility code in this repository.

## Resource budget (hard requirement)

xPanel must install and run well on low-spec servers (1 vCPU, 1 GB RAM) and reserve as little as possible for itself. Every choice is weighed against this budget.

| Panel component | Idle budget |
|---|---|
| API (Node, one process) | ≤ 60 MB RSS, < 0.5% CPU |
| Agent / reconciler (Node, one process) | ≤ 50 MB RSS, < 0.5% CPU; work is event-driven, no busy polling |
| Index database | SQLite built into Node (`node:sqlite`), one file, WAL mode — no database server, ~0 MB idle |
| Web UI | static files served by Nginx; no SSR process; initial JS ≤ 200 KB gzip, each route chunk ≤ 60 KB gzip |
| Install size | panel itself ≤ 200 MB on disk (excluding distro services) |

Rules that follow from it:
- Only enabled services are installed and running (mail, DNS, FTP, OpenLiteSpeed, ModSecurity, Redis are opt-in). PowerDNS runs its BIND backend on rendered zone files, so DNS needs no database server.
- PHP-FPM pools default to `pm = ondemand` with an idle timeout, so idle sites cost no workers. Apache/itk and Nginx worker counts are sized from cores and memory by the setup wizard.
- Monitors sample cheap kernel counters (cgroup `*.stat`, `/proc`) at a modest interval and store rolled-up history; logs are read incrementally, never re-scanned.
- Node processes run with bounded heaps (`--max-old-space-size`) and stream large data (archives, logs, uploads) instead of buffering.
- No dependency is added when the platform or an existing dependency covers the need.

## State storage (decided 2026-10-22)

Configuration files are the source of truth, the way cPanel keeps `/var/cpanel/users` and `userdata`. A broken database must never lose or corrupt a customer's setup.

- **Why SQLite:** with desired state in files the database only holds rebuildable data, so a server process is pure cost. SQLite ships inside Node 24, needs no dependency, runs in-process for the API and the agent, and is the most widely deployed database engine. The API wakes the agent over a local unix socket (`/run/xpanel/agent.sock`), which also carries synchronous jobs such as file-manager operations.
- **Desired state = files.** One file per entity under `/var/lib/xpanel/state/` (`server`, `plans/<name>`, `resellers/<name>`, `accounts/<user>`, `accounts/<user>/domains/<domain>`, `firewall`, …). Written atomically (temp file → fsync → rename → fsync dir), validated by the same schemas as the API, owned by the `xpanel` user, mode 0640, read by the root agent which re-validates everything.
- **Every change is a state generation.** The agent renders host config from the state tree, tests it, then switches; the state tree of each applied generation is kept for rollback.
- **The index database is derived and operational only.** It is SQLite (`node:sqlite`, WAL, `/var/lib/xpanel/index.db`) and holds the search/list index of the state files, sessions, login attempts, jobs, metrics history and an index of the audit log. `xpanel reindex` rebuilds it from the files; on any mismatch the file wins. Losing the database costs sessions and history, never configuration.
- **The audit log is an append-only JSON-lines file** (`/var/log/xpanel/audit.log`) first and indexed into SQLite second.
- **Isolation from service databases.** The index database is a private file of the panel (mode 0600, owner `xpanel`); there is no database server for the panel at all, so nothing else can connect to it. Customer databases live only in MariaDB. PowerDNS uses the BIND backend reading zone files rendered by the agent, so DNS has no database at all.

## Architecture

Clean architecture, dependencies point inward:

```
packages/core        domain types, errors, limits, pure rules     ← imports nothing internal
packages/catalog     tool catalog + visibility                    ← core
packages/os          OS profiles, install plans (pure)             ← core
packages/render      config renderers (pure, string in → out)      ← core
packages/state       desired-state files: schemas, atomic store     ← core
packages/db          index + operational tables, migrations        ← core
packages/lifecycle   upgrade / backup / transfer / cPanel import   ← core, render, os, state (ports injected)
apps/api             HTTP adapter: auth, validation, use cases      ← core, catalog, state, db, render, lifecycle
apps/agent           reconciler: state files → host                 ← core, state, db, os, render, lifecycle
apps/web             UI                                             ← core (types only), catalog
```

- Renderers and rules are pure. Side effects happen only in `apps/agent` executors, through the `HostAction` contract in `packages/core/src/system.ts`.
- The API never executes system commands. It writes desired-state files and jobs; the agent applies them.
- No layer imports a layer above it. The web app never imports server code except types.

## Single source of truth

| Truth | Lives in |
|---|---|
| Domain types, error codes, limits | `packages/core/src/{types,errors,limits}.ts` |
| Host side-effect contract, OS profile shape | `packages/core/src/system.ts` |
| Business rules (caps, ACLs, naming, handlers, firewall lockout) | `packages/core/src/rules/` |
| Tools, groups, feature keys, ACL gates | `packages/catalog/src/data/` |
| Distribution package/service/path names | `packages/os/src/` |
| Desired state (accounts, domains, plans, resellers, server, firewall…) | files under `/var/lib/xpanel/state/`, shaped by `packages/state` schemas |
| Index and operational data shape | `packages/db/src/migrations/*.sql` (Drizzle schema mirrors it) |
| Translations | English source strings in code/catalog; `locales/<bcp47>.json` per language (catalog) and Lingui catalogs (web) |
| API request/response schemas | zod schemas in `apps/api`, exported for web forms and OpenAPI |
| Design tokens and components | the xPanel design system → `apps/web` theme |

Never copy a constant, enum or validation rule; import it.

## Code

- TypeScript 6, ESM, Node 24 native type stripping: relative imports end in `.ts`; no enums, namespaces or parameter properties; `import type` for types.
- English everywhere: identifiers, comments, commit messages, docs, UI source strings. User-facing text goes through i18n (English source, Arabic translation).
- Small functions with intent-revealing names. Comments explain *why*, not *what*.
- Errors are `XpanelError` with a stable `ErrorCode`; never swallow, never leak internals.
- No `TODO`, `FIXME`, dead code, unused exports, shims or "temporary" paths. Ship complete cutovers.
- No premature abstraction: one implementation, no plugin layer until a second real case exists.

## Standards conformance

| Area | Standard |
|---|---|
| HTTP semantics, status codes | RFC 9110 |
| API errors | RFC 9457 problem details (`application/problem+json`) |
| API description | OpenAPI 3.1 generated from the same zod schemas |
| Timestamps | RFC 3339 / ISO 8601, UTC in storage and APIs |
| Language tags | BCP 47 (`en`, `ar`) |
| TOTP | RFC 6238 (RFC 4226 HOTP base) |
| Password hashing | Argon2id (RFC 9106) |
| Cookies | RFC 6265bis: `Secure; HttpOnly; SameSite=Strict` |
| Bearer tokens | RFC 6750 |
| ACME | RFC 8555 (HTTP-01, DNS-01; wildcards via DNS-01) |
| DNS names and records | RFC 1035, RFC 5890–5891 (IDNA), RFC 8659 (CAA) |
| Mail | RFC 5321 / 5322, SPF RFC 7208, DKIM RFC 6376, DMARC RFC 7489 |
| TLS | RFC 8446 (TLS 1.3), TLS 1.2 minimum |
| Versioning | SemVer 2.0.0; control-DB schema numbered separately |
| Accessibility | WCAG 2.2 AA |
| Usability | ISO 9241-110 dialogue principles, ISO 9241-11 |
| Product quality model | ISO/IEC 25010 (security, reliability, maintainability) |
| Security controls | OWASP ASVS 4 level 2; audit trail in the spirit of ISO/IEC 27001 A.8.15 |

## Security baseline

- Validate every input at the boundary with a schema; validate again where a value becomes a path, unit name, config line or SQL identifier (strict allow-list, reject — never silently sanitize).
- argv arrays only; never a shell string. Timeouts on every external command.
- Least privilege: API runs as an unprivileged user; the agent is the only root process; account workloads run as their own UID inside `xpanel-<uid>.slice`.
- Secrets never in code, logs, audit details or URLs. Audit entries redact keys matching `pass|secret|token|key`.
- Sessions: rotating IDs, idle and absolute timeouts, CSRF protection on state-changing requests, login lockout by username and by IP, 2FA for root.
- API tokens stored as hashes, scoped, expiring, optionally IP-bound.
- Firewall changes are refused if they would lock out the current session.
- Supply chain: permissive licenses only (MIT, Apache-2.0, BSD, ISC); lockfile committed; install scripts allow-listed; `pnpm audit` clean of high/critical.

## Testing

- Every rule, renderer and repository has unit tests next to it (`*.test.ts`, vitest). Test behavior, edge cases and failure paths — injection attempts, unlimited values, boundary caps.
- API: request-level tests for 2xx, 4xx validation, 401/403 auth, 409/422 domain errors.
- Agent: fake executor tests for every reconcile path; Linux integration proofs in a systemd container for isolation claims (see [ARCHITECTURE.md](ARCHITECTURE.md), Proofs).
- UI: component tests for logic; Playwright walk-throughs with axe checks for every ready tool.
- A catalog tool is `ready` only when its acceptance test exists and passes.

## UI / UX

The xPanel design system is the reference; `apps/web` implements it.

- English first, LTR; Arabic is a complete RTL locale via logical CSS properties and `dir`.
- WCAG 2.2 AA: contrast ≥ 4.5:1, visible focus, labels bound to inputs, no color-only meaning, keyboard reachable everything.
- ISO 9241-110: suitability for the task, self-descriptiveness, conformity with expectations, error tolerance, controllability, learnability.
- Proportion: main : aside = 1.618 : 1; paragraph line-height 1.6; spacing steps 16 → 26 → 42 at field → card → section level.
- Ergonomics: targets ≥ 44 px (Fitts), ≤ 7 choices per menu (Hick), forms chunked into sections of ≤ 7 fields (Miller), prose ≤ 68ch.
- Every data view has loading (skeleton), empty, error and no-permission states. Every consequential action confirms and gives feedback ("Reconciling… → applied in generation #143").

## Governance

- Conventional Commits. SemVer releases with a changelog start at launch; until then the prelaunch policy applies. The product's upgrade engine enforces expand-only migrations for customer servers.
- Every administrative action is written to the append-only audit log.
- Behavior is taken from public documentation and rebuilt; no proprietary cPanel, WHM or aaPanel code, layouts or assets are copied.
- Definition of done: code + tests + typecheck + lint green, catalog status updated, docs touched where behavior changed, no gate open.
