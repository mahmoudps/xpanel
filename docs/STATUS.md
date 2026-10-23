# Project status

Status as of 2026-10-23: **prelaunch; NO-GO for production**. No accepted completion percentage is asserted. Passing tests, available renderers and capability definitions measure different things and must not be added together as product completion.

## Implemented foundations

- A TypeScript workspace with 7 libraries and 3 applications, pinned to Node 26.12.1 and pnpm 12.15.0.
- File-based desired hosting state, SQLite identity/security repositories and operational storage.
- Password hashing, persistent session and MFA state, credential-change revocation, scoped tokens, ownership/ACL checks and bounded authenticated WebSocket transport.
- Separate API and privileged agent processes, protected local IPC, native peer-identity and account-file helper implementations, explicit host execution contracts and service adapters.
- Configuration renderers, reconciliation and lifecycle state machines, with production integration still requiring end-to-end acceptance.
- Server-rendered English/Arabic UI, compact independent xPanel/xWHM/xMail login forms, aligned field/value groups and responsive navigation primitives.
- A page-only palette built from all destinations currently available to the authorized surface, with localized filtering, Arrow Up/Down selection, Enter navigation, a no-match state, bounded internal scrolling and modal focus return. It is not a command executor or a substitute for server authorization.
- A mail rendering layout with three total columns on wide screens: folders, message list and reading pane. Composition has a separate editor layout; its Send control is disabled and non-submitting until real delivery is connected and qualified. This does not close the mailbox/webmail acceptance gate.
- Three immutable application profiles in one unprivileged process: public HTTPS ports `2083/2087/2096`, private loopback HTTP ports `12083/12087/12096`, exact-origin ingress checks and audience-bound session/CSRF credentials. This is source implementation, not public TLS deployment qualification.
- An authenticated read-only workspace summary restricted to authorized account/plan fields; it does not expose unavailable hosting actions or imply service health.
- Account-action UI and API guards with current-target authorization, revision checks, linked-principal credential revocation and verification-required outcomes. A dialog or acknowledged global configuration is not target-bound hosting completion. DELETE and contact-email-only PATCH deliberately return 412 while their safe production contracts remain unavailable.
- Deterministic source-release packaging with manifests, integrity checks, runtime import closure and explicit separation of reference material from runtime inputs.

These foundations do not imply that every hosting workflow is connected, exposed or qualified. The catalog currently has **0 verified capabilities**. Unqualified capabilities remain unavailable in production navigation.

## Verification layers and current publication status

| Layer | Defined scope; see exact-commit CI for results | What it establishes |
|---|---|---|
| Portable | Portable suite | Rules, repositories, renderers, adapters and local HTTP behavior within each fixture's scope; Windows and Ubuntu counts differ for platform-specific named-pipe cases |
| Type checking | 10 workspace projects | Static consistency for the checked sources |
| Chromium application acceptance | 6 scenarios | Selected authentication, scope, asset/surface and bilingual flows in a real browser; host execution is a declared fake |
| Synthetic workspace UI in Chromium | 18 states across 9 selected routes | Navigation, keyboard/focus behavior, responsive geometry and Arabic alignment at 360/768/1440px using synthetic data |
| Independent login visual matrix | 60 states defined | 3 compact login profiles, EN/AR, light/dark and 320/360/390/768/1440px; no authentication or public TLS proof |
| Navigation interaction matrix | 76 cases defined | Back/Forward, context links, active route, responsive focus, field alignment, long forms, reduced motion, bounded summary, page filtering, keyboard activation and palette scrolling in synthetic fixtures |
| Mail layout matrix | 24 states defined | Inbox/Compose, EN/AR, light/dark, 360/768/1440px, loaded fonts, logical field edges, mixed-text direction, responsive panes, keyboard visibility and non-submission; no mailbox or delivery proof |
| Accounts interaction matrix | 24 states defined | Account list/action dialog and creation form, EN/AR, light/dark, 360/768/1440px, actual applied fonts, 8px field gaps, keyboard/focus and synthetic JSON outcomes; no native lifecycle proof |

The account mutation regressions separately exercise fresh authorization, current persisted targets, compare-and-swap revisions, bounded agent replies and linked-principal credential revocation. A global configuration acknowledgement retains `targetVerified: false` and `verificationRequired: true`. DELETE refuses with `target_bound_purge_unavailable`; contact-email-only PATCH refuses with `metadata_index_update_unqualified`. Both are HTTP 412 without the requested effects. These refusals improve safety and do not deliver account deletion or full account editing.

The clean checkout and CI must repeat these commands for every exact published source revision. Use the result attached to that commit; earlier results do not automatically apply to an update. Defined case counts describe coverage, not successful execution or production acceptance. See [TESTING.md](TESTING.md). Browser UI evidence does not qualify all routes, form mutations, live authorization changes, native services, capacity, INP or CLS.

A reduced-motion focus defect was identified: reducing a visibility transition to a tiny duration still allowed the navigation sheet to remain hidden during its focus call. The source now disables transitions and animations under the preference and uses immediate scrolling. Re-run the unchanged focus requirements against the final export; do not convert earlier failures into successful evidence.

The UI typography contract uses IBM Plex Sans and IBM Plex Sans Arabic, uses Sans for brands and ordinary controls, and confines monospace to technical content. Caption/label/body/card/page roles and shared spacing require actual browser inspection; loaded fonts alone do not prove visual consistency. No full-screen visual acceptance or final matrix pass is asserted by these definitions.

Native Linux tests are separate from portable checks. Their implementations and fixture results do not automatically qualify an installation, reboot, tenant workload or service deployment on a different source revision or operating system.

## Work remaining before launch

1. **Production wiring and truthful delivery:** implement a durable target-bound account lifecycle/purge contract with restart/recovery receipts before enabling deletion or claiming account completion. The lifecycle coordinator is not connected as a qualified production executor and is not a drop-in replacement. Complete runner and lifecycle-port wiring, connect every supported operation to actual execution, and replace fixture or metadata-only behavior with independently observed outcomes. Seven owner pages now separate administrative actions into root-only metadata destinations. Three bounded owner contracts for site configuration, reverse proxy and rewrite controls remain unavailable. The 195 navigation definitions are metadata, not 195 implemented or qualified screens.
2. **Hosting services:** qualify account creation/removal, Apache/PHP workload identity, cgroup and quota enforcement, MariaDB, DNS, certificates, SMTP/IMAP, FTP and cron with real daemons, positive controls and cross-account negative tests. A configuration renderer or successful primitive is insufficient.
3. **Security:** finish the full authorization and route inventory, mailbox authority, target-host ingress/TLS policy, privileged boundary coverage, root authentication policy, durable audit and process-failure acceptance. xMail currently authenticates the account control-plane identity, not mailbox credentials. Revalidate the three profiles under replay, ownership changes, revocation and HTTP/WebSocket denial; loopback tests do not qualify public exposure.
4. **Recovery:** prove consistent identity/key/configuration backup, granular and whole-server restore, large archive safety, real cPanel import, resumable transfers and upgrade rollback against actual data and services. Include interrupted and repeated attempts.
5. **Performance:** qualify the new bounded fresh account/policy reads and their lock costs under representative Linux concurrency. The lease still has real fencing/metadata-write cost, and qualified service screens retain full-snapshot reads. No authorization cache is introduced. The inherited full-snapshot consistency/recovery gap remains open under R01. Measure representative data, concurrency, cursors and retention; verify memory, CPU, asset and installation budgets on declared Linux profiles. Local fixture timings, Windows RSS and anonymous health responses cannot establish production INP, Linux budgets or authenticated capacity.
6. **Release operations:** qualify fresh installation, runtime/native artifact provenance, reboot, supported distributions, monitoring, retention and executable recovery runbooks. Existing installations require explicit API-environment and atomic additive firewall migration before enabling the three HTTPS profiles; preserved files are not automatically migrated. Review [runbooks](operations/runbooks.md) against the exact implementation before using their commands.
7. **Pilot:** complete a measured 30-60 day pilot with incident, security, capacity, recovery and operator evidence, followed by an explicit launch decision.

The [acceptance matrix](planning/ACCEPTANCE-MATRIX.md) defines observable acceptance; [scenario mapping](planning/acceptance-scenario-mapping.json) must point to real executable harnesses and matching evidence. A missing harness, unmet prerequisite, skip or blocked environment leaves its acceptance open.
