# Project status

Status as of 2026-10-22: **prelaunch; no production go-ahead**. No completion percentage is asserted. Passing tests, available renderers and capability definitions measure different things and must not be added together as product completion.

## Implemented foundations

- A TypeScript workspace with 7 libraries and 3 applications, pinned to Node 26.12.1 and pnpm 12.15.0.
- File-based desired hosting state, SQLite identity/security repositories and operational storage.
- Password hashing, persistent session and MFA state, credential-change revocation, scoped tokens, ownership/ACL checks and bounded authenticated WebSocket transport.
- Separate API and privileged agent processes, protected local IPC, native peer-identity and account-file helper implementations, explicit host execution contracts and service adapters.
- Configuration renderers, reconciliation and lifecycle state machines, with production integration still requiring end-to-end acceptance.
- Server-rendered English/Arabic UI, authentication flows, navigation and responsive interaction primitives.
- Deterministic source-release packaging with manifests, integrity checks, runtime import closure and explicit separation of reference material from runtime inputs.

These foundations do not imply that every hosting workflow is connected, exposed or qualified. The catalog currently has **0 verified capabilities**. Unqualified capabilities remain unavailable in production navigation.

## Recorded development verification

| Layer | Recorded result | What it establishes |
|---|---|---|
| Portable | 2332 passing tests in 110 files | Rules, repositories, renderers, adapters and local HTTP behavior within each fixture's scope |
| Type checking | 10 workspace projects pass | Static consistency for the checked sources |
| Chromium application acceptance | 6 passing scenarios | Selected authentication, scope, asset/surface and bilingual flows in a real browser; host execution is a declared fake |
| Synthetic UI acceptance in Chromium | 18 passing states across 9 selected routes | Navigation, keyboard/focus behavior, responsive geometry, Arabic alignment and selected font readiness at 360/768/1440px using synthetic data |

The clean checkout and CI must repeat these commands for the exact published source. Counts are a dated baseline, not a permanent minimum or a claim that CI has already run. See [TESTING.md](TESTING.md). Browser UI evidence does not qualify all routes, form mutations, live authorization changes, native services, capacity, INP or CLS.

Native Linux tests are separate from portable checks. Their implementations and fixture results do not automatically qualify an installation, reboot, tenant workload or service deployment on a different source revision or operating system.

## Work remaining before launch

1. **Production wiring and truthful delivery:** complete runner and lifecycle-port wiring, connect every supported operation to actual execution, and replace fixture or metadata-only behavior with independently observed outcomes. Repair the 10 known owner/root navigation contracts, including authority and metadata separation, before exposing the affected administrative functions.
2. **Hosting services:** qualify account creation/removal, Apache/PHP workload identity, cgroup and quota enforcement, MariaDB, DNS, certificates, SMTP/IMAP, FTP and cron with real daemons, positive controls and cross-account negative tests. A configuration renderer or successful primitive is insufficient.
3. **Security:** finish the full authorization and route inventory, mailbox authority, proxy/origin/TLS policy, privileged boundary coverage, root authentication policy, durable audit and process-failure acceptance. Verify every channel under ownership changes and revocation.
4. **Recovery:** prove consistent identity/key/configuration backup, granular and whole-server restore, large archive safety, real cPanel import, resumable transfers and upgrade rollback against actual data and services. Include interrupted and repeated attempts.
5. **Performance:** measure authenticated pages and operations with representative data, bounded concurrency, cursors and retention. Verify memory, CPU, asset and installation budgets on declared profiles; anonymous health responses cannot establish authenticated scale.
6. **Release operations:** qualify fresh installation, runtime/native artifact provenance, reboot, supported distributions, monitoring, retention and executable recovery runbooks. Review [runbooks](operations/runbooks.md) against the exact implementation before using their commands.
7. **Pilot:** complete a measured 30-60 day pilot with incident, security, capacity, recovery and operator evidence, followed by an explicit launch decision.

The [acceptance matrix](planning/ACCEPTANCE-MATRIX.md) defines observable acceptance; [scenario mapping](planning/acceptance-scenario-mapping.json) must point to real executable harnesses and matching evidence. A missing harness, unmet prerequisite, skip or blocked environment leaves its acceptance open.
