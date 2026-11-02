# Project status

Status as of 2026-11-01: **prelaunch; NO-GO for production**. No accepted completion percentage is asserted. Passing tests, available renderers and capability definitions measure different things and must not be added together as product completion. The 2026-10-23 foundations below remain; the source inventory corrects the delivery and navigation statements that no longer match the code.

## Implemented foundations

- A TypeScript workspace with 7 libraries and 3 applications, pinned to Node 26.12.1 and pnpm 12.15.0.
- File-based desired hosting state, SQLite identity/security repositories and operational storage.
- Password hashing, persistent session and MFA state, credential-change revocation, scoped tokens, ownership/ACL checks and bounded authenticated WebSocket transport.
- Separate API and privileged agent processes, protected local IPC, native peer-identity and account-file helper implementations, explicit host execution contracts and service adapters.
- Configuration renderers, reconciliation and lifecycle state machines, with production integration still requiring end-to-end acceptance.
- Server-rendered English/Arabic UI, compact independent xPanel/xWHM/xMail login forms, aligned field/value groups and responsive navigation primitives.
- A page-only palette built from all destinations currently available to the authorized surface, with localized filtering, Arrow Up/Down selection, Enter navigation, a no-match state, bounded internal scrolling and modal focus return. It is not a command executor or a substitute for server authorization.
- A mail rendering layout with three total columns on wide screens: folders, message list and reading pane. Composition has a separate non-form editor and an enabled Send control connected to the product's mail handler. Browser layout checks do not click Send or establish delivery. This does not close the mailbox/webmail acceptance gate.
- Three immutable application profiles in one unprivileged process: public HTTPS ports `2083/2087/2096`, private loopback HTTP ports `12083/12087/12096`, exact-origin ingress checks and audience-bound session/CSRF credentials. This is source implementation, not public TLS deployment qualification.
- An authenticated read-only workspace summary restricted to authorized account/plan fields; it does not expose unavailable hosting actions or imply service health.
- Account-action UI and API guards with current-target authorization, revision checks, linked-principal credential revocation and verification-required outcomes. Contact-email changes synchronize the account/index with compensating rollback. Deletion requires an advertised target-bound purge contract and otherwise refuses before changes. A dialog, acknowledged configuration or source contract does not qualify target-bound native hosting completion.
- Deterministic source-release packaging with manifests, integrity checks, runtime import closure and explicit separation of reference material from runtime inputs.

These foundations do not imply that every hosting workflow is connected, exposed or qualified. The shipped catalog has **0 verified capabilities**. A registered document can still render; rendering does not qualify its tools.

## Source inventory, 2026-11-01

Counted from this checkout, without treating a renderer, route or probe as acceptance:

| Source | Count | Admission consequence |
|---|---:|---|
| Catalog declarations in `packages/catalog/src/data/tools.ts` | 554 | 491 `researched`, 63 `out-of-scope` |
| Native declarations in `packages/catalog/src/data/native.ts` | 45 | No id overlap with the 554; all enter the same delivery assessment |
| In-scope tools | 536 | Each is placed on exactly one navigation page |
| Out-of-scope tools | 63 | None is placed on a navigation page |
| Navigation pages | 203 | 68 xPanel, 116 xWHM, 19 xMail |
| Registered document aliases | 14 | 7 account store aliases, 3 xWHM store aliases, 4 mailbox aliases |
| Registered documents | 217 | 203 pages plus 14 aliases; route hooks and V2 stylesheets cover this same set |
| Phase-1 host-probe entries | 113 | Prerequisites only; they do not accept a tool |
| Reduced qualified-scope notes | 50 | A later accepted workspace would still leave the named remainder unavailable |
| Production TypeScript files under `apps/` and `packages/` | 1286 | Excludes `*.test.ts` |
| Test TypeScript files under `apps/` and `packages/` | 961 | Fixture coverage, not a delivery receipt |

`packages/catalog/src/data/delivery.ts` ships `deliveryEvidence = []` and `deliveryTarget = null`. `assessDelivery` therefore leaves every in-scope tool `researched`. `apps/api/src/main.ts` starts with `startPanelEntrypoints()` and does not pass a trusted evidence bundle. `qualifyHostTools` is demotion-only: a passing Linux probe report cannot move `researched`, `implemented` or `integrated` to `verified`. The live agent `GET /health` classification does not emit the `control-plane` probe that the phase-1 map requires. Under the default qualification switch, a future accepted tool that depends on that probe would be narrowed back to `researched` by the live health payload.

Qualified navigation therefore stays closed for ordinary tools. `visibleNavigation` opens xPanel `/home` once the session names an account; the page body still waits until the active account record matches that session. The web renderer also admits `/whm/preferences` for a root or reseller session even though the catalog does not qualify it. Every other role-admitted document uses the unverified V2 layout. Its mutation controls stay disabled, and stored facts appear only inside the existing account, plan and mailbox boundary. xPanel's qualified shell lists registered owner pages; an unverified link is marked not live. xWHM and xMail qualified shells list a page only when `visibleNavigation` admits it.

The Linux executor implements group and user creation, user deletion, quota application, confined file writes, systemd reload and property changes, and a reviewed command allowlist. The reconciler renders edge, PHP-FPM, mail, MariaDB, FTP, DNS, TLS, cron, account slices and nftables configuration. `AccountLifecycleCoordinator` is constructed for prepared provisioning. A fresh observed host effect can be reported as account-scoped and target-verified; a replay stays `targetVerified: false`. Ordinary configuration acknowledgement stays `targetVerified: false` and `verificationRequired: true`. Purge is implemented only for `LinuxHostExecutor`: GET advertises `target-bound-userdel`, and POST runs `userdel -r` only when the username, terminating status, uid from 20000 through 60000 and `/home/<user>` agree. Any other executor makes DELETE return HTTP 412 `target_bound_purge_unavailable` before changes. None of these paths is a qualified production lifecycle.

Production API sources name 314 distinct `/api/` path literals, and the agent names 81 exact path checks. Those counts are source surface area. They do not mean each path mutates a live service or has acceptance evidence.

## Verification layers and current publication status

| Layer | Defined scope; see exact-commit CI for results | What it establishes |
|---|---|---|
| Portable | Portable suite | Rules, repositories, renderers, adapters and local HTTP behavior within each fixture's scope; Windows and Ubuntu counts differ for platform-specific named-pipe cases |
| Type checking | 10 workspace projects | Static consistency for the checked sources |
| Chromium application acceptance | 6 scenarios | Selected authentication, scope, asset/surface and bilingual flows in a real browser; host execution is a declared fake |
| Synthetic workspace UI in Chromium | 18 states across 9 selected routes | Navigation, keyboard/focus behavior, responsive geometry and Arabic alignment at 360/768/1440px using synthetic data |
| Independent login visual matrix | 60 states defined | 3 compact login profiles, EN/AR, light/dark and 320/360/390/768/1440px; no authentication or public TLS proof |
| Navigation interaction matrix | 88 cases defined | Back/Forward, context links, active route, responsive focus, field alignment, long forms, reduced motion, bounded summary, page filtering, keyboard activation, palette scrolling and audit spacing in synthetic fixtures |
| Mail layout matrix | 24 states defined | Inbox/Compose, EN/AR, light/dark, 360/768/1440px, loaded fonts, logical field edges, mixed-text direction, responsive panes, keyboard visibility and non-submission; no mailbox or delivery proof |
| Accounts interaction matrix | 24 states defined | Account list/action dialog and creation form, EN/AR, light/dark, 360/768/1440px, actual applied fonts, 8px field gaps, keyboard/focus and synthetic JSON outcomes; no native lifecycle proof |
| Development MFA presentation | 8 states defined | EN/AR sign-in and disabled-factor security pages at 360/1440px; synthetic password-only submission, actual input selection, fonts and geometry; runtime authority is tested separately over HTTP |
| Optional enrolled security presentation | 8 states defined | Root and user cards in EN/AR at 320/1440px; root-only confirmed recovery guidance, actual visible command glyphs, LTR isolation and shared content edges; synthetic presentation only, with runtime recovery authority tested separately |
| Registered V2 documents | 217 documents in source | 203 pages plus 14 aliases; English and Arabic read-only layouts for missing and supplied stored records, with mutation controls disabled. This replaces the former 118-route / 472-state description. Synthetic layout is not hosting qualification |
| Native management workflows | 12 states defined | Plans, scoped account filters and outbound settings in EN/AR at 360/1440px with synthetic API outcomes; no host or mail-delivery execution |
| Account, mail and application extensions | 112 states defined | 28 views in EN/AR at 360/1440px; unread data, catalog admission, typography, real field edges, accessibility and disabled operations remain explicit |

The account mutation regressions separately exercise fresh authorization, current persisted targets, compare-and-swap revisions, bounded agent replies and linked-principal credential revocation. A global configuration acknowledgement retains `targetVerified: false` and `verificationRequired: true`. DELETE refuses with HTTP 412 and `target_bound_purge_unavailable` before changes when the agent contract is absent. With an accepted contract, purge failure returns HTTP 503 with verification required and the account retained as terminating. Successful purge precedes identity and account/index removal. Contact-email-only PATCH has a metadata/index write and compensating rollback path; a failed index update reports whether state may have changed. These contracts and fixtures do not establish native purge, lifecycle safety or production availability.

The clean checkout and CI must repeat these commands for every exact published source revision. Use the result attached to that commit; earlier results do not automatically apply to an update. Defined case counts describe coverage, not successful execution or production acceptance. See [TESTING.md](TESTING.md). Browser UI evidence does not qualify all routes, form mutations, live authorization changes, native services, capacity, INP or CLS.

A reduced-motion focus defect was identified: reducing a visibility transition to a tiny duration still allowed the navigation sheet to remain hidden during its focus call. The source now disables transitions and animations under the preference and uses immediate scrolling. Re-run the unchanged focus requirements against the final export; do not convert earlier failures into successful evidence.

The UI typography contract uses IBM Plex Sans and IBM Plex Sans Arabic for ordinary controls and text. The dedicated sign-in and reference mail wordmarks use IBM Plex Mono; other monospace content remains technical. Caption/label/body/card/page roles and shared spacing require actual browser inspection; loaded fonts alone do not prove visual consistency. No full-screen visual acceptance or final matrix pass is asserted by these definitions.

Native Linux tests are separate from portable checks. Their implementations and fixture results do not automatically qualify an installation, reboot, tenant workload or service deployment on a different source revision or operating system.

## Work remaining before launch

1. **Production wiring and truthful delivery:** supply a pinned acceptance bundle only after real observations exist, then prove the live health report can retain those accepted tools. The purge route and provisioning coordinator exist in source and still lack restart, recovery and target-host qualification. Seven root-only destinations (`/whm/email/bcc`, `/whm/email/marketing`, `/whm/services/ftp-log-analysis`, `/whm/software/deployments`, `/whm/software/application-projects`, `/whm/software/composer`, `/whm/services/default-index`) have read-only documents and no artboard or primary action; their summaries keep the administrative action unavailable until qualified. Owner site settings and `.htaccess` stay out of qualified navigation until their own tools are verified. Reverse proxy enters qualified navigation only with a verified `domains` tool. The owner reverse-proxy and `.htaccess` API contracts are source implementations, not delivery receipts. A registered document remains a navigation destination, not evidence that its hosting operation works.
2. **Hosting services:** qualify account creation/removal, Apache/PHP workload identity, cgroup and quota enforcement, MariaDB, DNS, certificates, SMTP/IMAP, FTP and cron with real daemons, positive controls and cross-account negative tests. A configuration renderer or successful primitive is insufficient.
3. **Security:** finish target-host ingress/TLS policy, privileged boundary coverage, durable audit and process-failure acceptance. xMail opens a sealed canonical mailbox session after mailbox credential verification, and HTTP/WebSocket authorization rechecks current account and service policy. These source contracts and loopback regressions do not qualify an installed IMAP/SMTP service or public exposure. Revalidate the three profiles under replay, ownership changes, revocation and HTTP/WebSocket denial. Development disables runtime MFA through captured startup policy; production enrollment remains optional, with enrolled factors enforced.
4. **Recovery:** prove consistent identity/key/configuration backup, granular and whole-server restore, large archive safety, real cPanel import, resumable transfers and upgrade rollback against actual data and services. Include interrupted and repeated attempts.
5. **Performance:** qualify the new bounded fresh account/policy reads and their lock costs under representative Linux concurrency. The lease still has real fencing/metadata-write cost, and qualified service screens retain full-snapshot reads. No authorization cache is introduced. The inherited full-snapshot consistency/recovery gap remains open under R01. Measure representative data, concurrency, cursors and retention; verify memory, CPU, asset and installation budgets on declared Linux profiles. Local fixture timings, Windows RSS and anonymous health responses cannot establish production INP, Linux budgets or authenticated capacity.
6. **Release operations:** qualify fresh installation, runtime/native artifact provenance, reboot, supported distributions, monitoring, retention and executable recovery runbooks. Existing installations require explicit API-environment and atomic additive firewall migration before enabling the three HTTPS profiles; preserved files are not automatically migrated. Review [runbooks](operations/runbooks.md) against the exact implementation before using their commands.
7. **Pilot:** complete a measured 30-60 day pilot with incident, security, capacity, recovery and operator evidence, followed by an explicit launch decision.

The [acceptance matrix](planning/ACCEPTANCE-MATRIX.md) defines observable acceptance; [scenario mapping](planning/acceptance-scenario-mapping.json) must point to real executable harnesses and matching evidence. A missing harness, unmet prerequisite, skip or blocked environment leaves its acceptance open.
