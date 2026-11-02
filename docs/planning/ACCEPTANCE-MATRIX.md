# Release acceptance and qualification matrix

This document defines requirements, not completed acceptance. Each scenario starts as `not_run` until a reviewed execution receipt establishes a result for the exact source, release artifact, environment, and independent oracle.

> **Evidence warning:** The companion [scenario mapping](acceptance-scenario-mapping.json) retains legacy `portablePrimitiveVerified` and `verificationStatus` fields for schema compatibility. They do not establish acceptance. Its authoritative assessment is `evidenceAssessment: declarative_unaccepted` and `independentAcceptance: false`. Matrix/schema consistency does not prove that a harness ran. All mapped supporting paths and test declaration anchors are checked by the coverage validator; their explicit partial coverage and remaining gaps do not establish the required environment observations. A passing metadata test cannot close a scenario or release gate.

See [testing](../TESTING.md), [status](../STATUS.md), [engineering standards](../STANDARDS.md), [authorization inventory](authorization-route-matrix.json), and [operational runbooks](../operations/runbooks.md). Scenario IDs are engineering traceability identifiers, not customer document numbers.

## 1. Acceptance rules

A successful workflow connects an authorized actor to an observed operating-system or service effect, a correct browser state, and an audit record. A button, JSON record, or HTTP `201` does not prove service creation. A separate `setpriv ... id` process does not prove which Apache worker served a request. Results using a fake host executor must not be promoted to Linux service evidence.

Execution states are `not_run`, `running`, `passed`, `failed`, `blocked`, and `not_applicable`. Missing root access, systemd, services, or an external network observer means `blocked`, not success. `not_applicable` requires a published support-profile reason and cannot waive tenant isolation or recovery. Changed code or configuration invalidates dependent results until appropriate revalidation.

## 2. Environments and fixtures

| Code | Environment | Evidence boundary |
|---|---|---|
| U | Unit/property tests | Rules, schemas, policies, and renderers; no service execution proof |
| H | Real loopback HTTP with a test store | Contracts, permissions, sessions, and responses; identify fake host executors explicitly |
| B | Real browser running the release bundle | JavaScript, requests, fields, focus, interactions, loading, and reconnect behavior |
| V | Disposable Linux VM with systemd, cgroup v2, and real services | Identity, quotas, ports, installation, and recovery; destructive tests must not use customer hosts |
| E | Observer/service outside the application VM | DNS, certificates, test mail, remote storage, and externally observed ports |

Use distinct tenant roles A/B, reseller roles A/B, and mailboxes on different accounts. Fixture factories must generate valid Linux usernames such as `tenanta` and `tenantb`. Mark files, database rows, and messages to detect cross-tenant leakage without customer data. Generate credentials during execution and omit their values from receipts.

Exercise direct ingress, trusted reverse proxies, and forged forwarded headers from untrusted peers. Cover root, reseller, account, mailbox, scoped API token, and anonymous callers, with valid, expired, and revoked sessions. Pair every permitted mutation with a rejected request and compare side effects, including lists, search, export, and event subscriptions.

## 3. Required scenarios

P0 blocks production use; P1 blocks release of the affected core capability; P2 blocks its quality gate. Split rows into smaller test cases where necessary while preserving their scenario IDs.

Early `primitive` evidence and later `integrated` evidence are separate observations. A future service package must not create a circular prerequisite for an early policy test. Exercise the available real primitive in a documented fixture, then repeat integration when its service is introduced. Transaction-test services are V prerequisites independent of product installation. Identity recovery needs a consistent local identity/key backup before account-backup integration. Account termination needs a comparable local recovery artifact early and a full SQL/mail/cron recovery test later.

### G0: Toolchain and reproducibility

| Scenario | Packages | Priority | Setup, actor, and action | Independent observation required | Environments | Guard against false acceptance |
|---|---|---|---|---|---|---|
| A01 | B01, B03 | P1 | CI installs a fixed checkout and lockfile in a clean worker, then runs typechecks/tests | Record versions, commands, exits, tree hashes, and untracked runtime inputs; no implicit directory substitution | U, H | Missing trusted registry/cache or dependence on stale dependencies means blocked |
| A02 | B03, Q03 | P1 | Attempt Linux qualification without privileges, then on a prepared VM | First run reports blocked; second provides separate PID/UID/cgroup/service observations | U, V | No successful skip, HTTP relabeled as browser E2E, or hidden execution on shared hosts |
| A03 | B02 | P1 | Catalog evaluator binds ready claims to tests, release identity, and support profiles | Missing, stale, or failed evidence keeps capabilities unproven, distinct from out-of-scope | U | A matching string or filename is insufficient |

### G1: Security and privilege boundaries

| Scenario | Packages | Priority | Setup, actor, and action | Independent observation required | Environments | Guard against false acceptance |
|---|---|---|---|---|---|---|
| A04 | S02 | P0 | Exchange Argon2id vectors with an independent implementation in both directions | Compatible verification, rejected invalid schemes/parameters, bounded concurrency, no secret exposure | U, H | Self-verification or an algorithm-name prefix alone proves no interoperability |
| A05 | S01 | P0 | Root with a read-only token attempts create/delete/job actions at every entry point | Denial before file/DB/host effects; audit required scope without token value | H, V | A `403` after an effect is not success |
| A06 | S01, H03 | P0 | Account A requests B by ID, list, search, export, HTML, and aggregate routes | No data or existence leak; HTML, attachments, and events share ownership policy | H, B | Test existing HTML policy in G1 and repeat the actual H03 bundle in G3; missing filters never expand scope |
| A07 | S01, H04 | P0 | Reseller without ACL or account without entitlement calls the authorized operation directly | Server denies before mutation; unrelated resellers cannot read/transfer accounts; owner changes update access | U, H | Hidden controls or navigation-only feature checks are insufficient |
| A08 | S01, M02 | P0 | Mailbox A requests B's messages, folders, identities, attachments, search, or mailbox parameter | No body/metadata leak or unauthorized sender identity; distinct mailbox markers | H, B, V | G1 exercises mailbox policy/store resources; repeat real authentication/IMAP/browser integration in G5 |
| A09 | S02, S05 | P0 | Correct password with incomplete MFA attempts REST/WS; reuse a recovery code | No full access before MFA; recovery code single use; reset revokes sessions | U, H, B | Test consumed TOTP-window replay; never persist raw recovery codes |
| A10 | S02, H02 | P0 | Bootstrap starts without secrets or with wrong permissions; retry old credentials | Fail closed or explicit local provisioning; no usable default account; permissions and rotation evidenced safely | H, V | Test bootstrap independently in G1 and from the installed artifact in G3; no compiled shared secret |
| A11 | S05, H03 | P0 | Real login component performs mutation, bad-CSRF, expiry, and logout flows | Only legitimate requests succeed; cookie attributes and revocation observed | H, B | Isolated real authentication is allowed early, followed by the full bundle; no injected login cookie |
| A12 | S01, S05 | P0 | IP-restricted, expired, or revoked tokens use REST/WS; direct client forges forwarded IP | Same restrictions at both entries; untrusted headers cannot replace peer IP; measured attempt limiting | H, V | WS without client-IP enforcement or only process-local throttling does not prove restart resistance |
| A13 | S05, R04 | P0 | Revoke a connected WS token or suspend ownership; test foreign Origin and slow client | Unauthorized data stops after revocation; Origin, heartbeat, backpressure, and frame limits hold | H, B, V | Test a real authorized fixture connection in G1, then durable job events after R04; reconnect alone is insufficient |
| A14 | S03 | P0 | Unprivileged API and unauthorized UID/missing/wrong credential call a separate agent socket | Authorized API succeeds; other callers denied; actual kernel peer UID, service UID, and socket modes recorded | V | Service credentials alone never prove kernel identity; no fabricated optional peer data, in-process fallback, or world-writable socket |
| A15 | S04 | P0 | Confined helper fails and then succeeds at account file I/O | Failure stops without root fallback; successful content/ownership and PID in the account slice observed | V | Root write followed by chmod does not prove account-identity execution |
| A16 | S04 | P0 | Tenant races symlinks, ancestors, renames, trash, restore, and extraction | No access outside authorized root; protected file hashes unchanged across race attempts | V | A single path/realpath check before open or Windows execution is not Linux race proof |
| A17 | S04, D04 | P0 | Concurrent helper/editor/upload channels exceed block/inode quotas or request forbidden modes | Kernel prevents excess; modes/owners correct; repeat for every new file channel | V, B | G1 proves helper/kernel; repeat FTP at A40 and restore at A49; UI limits are not kernel quotas |

### G2: State, reconciliation, and recovery

| Scenario | Packages | Priority | Setup, actor, and action | Independent observation required | Environments | Guard against false acceptance |
|---|---|---|---|---|---|---|
| A18 | R01, R02 | P0 | Independent API/agent processes allocate UIDs and update the same entity/generation while a writer crashes | Unique allocation; complete old/new state; locks/journal/revisions prevent lost updates | U, V | A process-local mutex or snapshots assembled from different instants are insufficient |
| A19 | R02, R03, D02 | P0 | Invalid configuration enters staging for real transaction-test Nginx/Apache/PHP/nft services | Real syntax rejection; active files/services unchanged; candidate paths and tests recorded | V, E | G2 proves the engine; repeat DNS in G4 and mail in G5; never put invalid config on a live path |
| A20 | R03 | P0 | Syntax passes, then second-service reload or health probe fails | Ordered restoration/reload and actual previous-service health; active generation matches observed state | V, E | Fake syntax failure or a rollback event without a probe is insufficient |
| A21 | R03, R04 | P0 | Kill agent or reboot VM during render/test/switch/reload/verify | Journal resumes or rolls back; no false active generation or repeated customer-data deletion | V | Inject each phase independently; a restart outside the critical window proves little |
| A22 | R02, H04, D04, D05, M01 | P0 | Delete the last entity owning a generated file/unit and reconcile | Manifest removes only obsolete owned outputs; access/service disappears; unmanaged files remain | V, E | Repeat engine deletion in G2, vhosts G3, FTP/cron/apps G4, and mailboxes G5; row removal is not access removal |
| A23 | R04 | P1 | Repeat an idempotency key, recover a crashed worker lease, and cancel a long job | One effect where provable, durable progress/checkpoints, safe cancellation and cleanup | H, V | Stored progress is not completion; do not promise universal exactly-once external effects |
| A24 | R05 | P0 | Allowed/denied changes with index outage or full audit disk, then rotation/restart | Declared policy prevents unaudited critical acknowledgments; durable recoverable log without secrets/line forgery | H, V | SQLite triggers alone do not prove file-first logging/hash chaining; test failed writes and retention |
| A25 | R01, S02 | P0 | Lose/rebuild SQLite index, then separately lose identity DB/sealing key | Hosting state survives; approved backup/recovery restores credentials/MFA; revoked tokens/sessions stay revoked | V | Consistent identity/key recovery is required in G2; reindex cannot recreate passwords/MFA |

### G3: Installation and real hosting lifecycle

| Scenario | Packages | Priority | Setup, actor, and action | Independent observation required | Environments | Guard against false acceptance |
|---|---|---|---|---|---|---|
| A26 | H01, H02 | P1 | Install an authenticated release artifact on a clean VM without development files | Runtime/assets/entrypoints present; hashes/units match; unprivileged API and independent agent | V | No nonexistent dist entrypoint, workstation dependencies, or implicit optional-service installation |
| A27 | H02 | P0 | Installer meets unsupported OS, missing itk, conflicting panel/ports, low space, or missing quota controller | Refusal before mutation or explicit conflict plan; preserve original configs | V | Package-name dry-run does not prove installation or distribution support; no silent shared-identity fallback |
| A28 | H01, H02 | P1 | Reboot installation and repeat installer/upgrade preflight | Services/socket/quotas/recovery and permissions survive; no duplicate users/config loss | V, E | Enabling a unit alone does not prove boot behavior |
| A29 | H03 | P1 | Fresh browser logs into release bundle with CSRF, then creates file or changes setting | No syntax/runtime errors; correct requests/routes, real effects, useful errors | B, V | Fetch/HTML regex does not execute JS; retain network/browser/service traces |
| A30 | S01, H03 | P0 | Anonymous caller or A requests `/whm`/B's HTML; then inspect an empty server | No unauthorized hosting data; honest empty state without demo tenants or invented generation/success | H, B | Authenticated JSON tests do not cover HTML hydration or cached tenant data |
| A31 | H05 | P0 | External HTTP to tenant vhost runs a bounded canary with trusted PID/UID observation | Serving worker and PHP use tenant UID/GID; Nginx cannot directly read tenant home | V, E | Config directives or separate identity commands are not request evidence; remove temporary canary |
| A32 | H05, D05, D04, M01 | P0 | Observe PHP/Apache/helper, then SSH/cron/apps/FTP/mail as introduced | Actual PID identity, cgroup membership, and limits for each workload | V | Repeat later-service workloads in G4/G5; UID is not cgroup membership |
| A33 | H05, Q01 | P0 | Tenant A stresses CPU/memory/IO/processes while B serves a stable canary | Effective caps; B throughput/latency, OOM/throttle/slice traces | V, E | cgroup settings alone are not enforcement; never stress production |
| A34 | H04, S01, D01, D05, M01, L02 | P1 | Manage plans, accounts, ownership, suspension, termination, then integrated services | G3 web/login/caps and local pre-delete recovery; G6 real SQL/mail/cron lifecycle | B, V, E | Local fixture backup is not complete L01/L02; repeat full multi-service termination in G6 |
| A35 | H04, D05 | P1 | Owner switches PHP version/handler/worker cap and exercises htaccess/alias/subdomain/wildcard | Real HTTP/PHP reflect choices; rewrite works; unavailable handlers explicitly denied | B, V, E | Generated configuration alone is insufficient; verify actual pool and worker caps without neighbor damage |

### G4: Account services

| Scenario | Packages | Priority | Setup, actor, and action | Independent observation required | Environments | Guard against false acceptance |
|---|---|---|---|---|---|---|
| A36 | D01 | P0 | A creates DB/user/grants, revokes grants, rotates password; B attempts access | Real least-privilege connections, immediate revocation, no access to B's databases | V | Compiled/fake SQL is not MariaDB execution; missing runner fails closed; protect admin connection |
| A37 | D01, L02 | P1 | Dump/restore data, routines/triggers/events, binary and UTF-8 through D01 adapter | Rows/checksums/objects match; unrelated databases unchanged; explicit consistency policy | V | Prove adapter round-trip in G4 and full L02 restore in G6; database names are not a dump |
| A38 | D02 | P1 | Root/A changes zones/records/serials and submits invalid update | External dig agrees; invalid zone leaves others intact; delegation/AXFR/recursion policy holds | V, E | JSON/local lookup alone is insufficient; observe external TCP/UDP |
| A39 | D03 | P1 | Independent test CA issues HTTP-01/DNS-01 apex/wildcard, renews, fails, and recovers | Challenge cleanup, valid service-used cert/key, old cert retained on failure with real retry/alert | V, E | Generated/self-signed fixtures are not issuance; cover skew, CAA, propagation, renewal blockers |
| A40 | D04, S04 | P0 | FTP/browser transfer and delete at quota limits with escape attempts | Real files under correct UID, confinement, TLS/passive policy, suspension denial | B, V, E | FTP metadata is not login; concurrent channels/extraction cannot bypass quota |
| A41 | D05, H05 | P0 | Authorized shell/cron/app, schedule changes, suspension, and secret environment | Real process/session/trigger under tenant UID/slice; no logged secrets; suspension policy holds | V, B | Synthetic stdout/unit text is insufficient; verify timezone/DST/missed-run behavior |

### G5: Mail and xMail

| Scenario | Packages | Priority | Setup, actor, and action | Independent observation required | Environments | Guard against false acceptance |
|---|---|---|---|---|---|---|
| A42 | M01, M02 | P1 | Two local mailboxes and external test mailbox use SMTP/IMAP/Webmail, IDLE, restart | IDs/flags/folders/attachments agree; IMAP changes reach UI; mailbox cannot administer account | B, V, E | JSON Sent/INBOX writes are not delivery; capture actual SMTP/IMAP |
| A43 | M03 | P0 | Valid/invalid/deferred/bounced/abusive mail exercises IP/DKIM/SPF/DMARC | External signature validation, distinct accepted/delivered/deferred/bounced states, no open relay, abuse limits | V, E | SMTP 250 is not final delivery; do not invent queue IDs from truncated UUIDs |
| A44 | M02, M03 | P0 | Hostile HTML/MIME, deceptive/large attachment, tracking image; B requests A's attachment | No script/unauthorized access/default tracking; browser-proven sandbox, sanitizer, streaming/limits | B, V | String escaping alone is insufficient; no customer mail fixtures |
| A45 | M04 | P1 | Sieve/vacation/forwarder with loops and invalid rules receives matching mail | Real delivery applies rules; errors preserve mailbox; no loop/backscatter; deletion removes rule | B, V, E | Saved compiled Sieve is not deployment; require compiler/service |
| A46 | M05, S01 | P0 | Import/export vCard/ICS; share/revoke; another account reads/modifies | Consistent data/timezones, effective permissions/revocation, ASCII display digits, malicious import denial | H, B | Separate client interoperability required for CalDAV/CardDAV; no accidental global calendar |

### G6: Backup, restore, transfer, and upgrade

| Scenario | Packages | Priority | Setup, actor, and action | Independent observation required | Environments | Guard against false acceptance |
|---|---|---|---|---|---|---|
| A47 | L01 | P1 | Full/partial backup of large changing files, databases, and mail under memory limit | Streamed archive, manifests/checksums/consistency; independent restoration verifies inclusion and omission | V | An index or DB names are not backup; dataset exceeds permitted RAM |
| A48 | L01, R04 | P1 | S3-compatible/SFTP backup with failed credentials, disconnect, retry | Verified remote artifact before success, truthful retry state, encryption/retention/key rotation | V, E | Destination metadata is not upload/restore; omit secrets from artifacts/logs |
| A49 | L02, S04 | P0 | File/DB/account restore faces traversal/symlinks/bombs and unconfirmed overwrite | Reject hostile archive before effects; preview diff; unrelated/absent files preserved | B, V | No direct privileged API writes; rollback overwritten files; enforce byte/entry limits |
| A50 | L02, R01 | P1 | Replace a lost VM using release, remote backup, and documented recovery keys | Files/SQL/mail/DNS/credentials/UID policy restored; external probes; independent RPO/RTO clock | V, E | Source VM unavailable during recovery; key survives source loss; no unmeasured SLA |
| A51 | L03 | P1 | Parse varied actual cPanel corpus bytes including SQL/mail/DNS/certs and unsupported cases | Conflict review, correct UID remap, content/row/mail/routing comparisons and differences | V, E | Request archive name is insufficient; compatible password import or explicit reset, never invented success |
| A52 | L04, R04 | P1 | Transfer between hosts with disconnect/restart and source changes before cutover | Resume/checkpoints/delta/final sync; pinned host key; DNS cutover/rollback; neighbor probes | V, E | Client-supplied events are not transfer evidence; avoid unnecessary shared restart |
| A53 | L05, R03 | P0 | Valid/corrupt/incompatible release; post-switch health failure and killed worker | Signature/preflight denial, recovered prior release/generation, unchanged tenant identities/hashes/DB | V, E | Upgrade row is not execution; run real ports and independent phase failures |

### G7: Performance, usability, and release readiness

| Scenario | Packages | Priority | Setup, actor, and action | Independent observation required | Environments | Guard against false acceptance |
|---|---|---|---|---|---|---|
| A54 | Q01 | P1 | Known CPU/IO rates, counter reset/reboot/log rotation, recollection | Correct monotonic deltas/rates, no totals-as-rate, offsets/retention prevent loss/duplicates | U, V | Nonzero charts are not metric correctness; declare units/denominators |
| A55 | Q01 | P1 | Measure fixed profiles/workloads from outside application host | Raw repeatable RSS/CPU/latency/heap/stream distributions meet budgets or reviewed evidence-based requirements | B, V, E | Means without p95/sample counts or same-host load are insufficient |
| A56 | Q02 | P1 | EN/AR at 360/390/768/1280px; empty/loading/error/denied and available print/PDF | Value under label at same edge; isolated LTR stays at RTL edge; ASCII digits/no overflow; screenshots and boxes | B | DOM order/dir alone is insufficient; include displayed opening balances, references, dates |
| A57 | Q02, Q03 | P1 | Keyboard/screen-reader core workflows, light/dark, 200% zoom | Focus/labels/modal return/announcements/contrast/actions; axe plus manual real-workflow review | B | Automated checks or aria regex alone do not establish WCAG conformance |
| A58 | Q02, R01 | P1 | Display/search/copy/print/export same job/backup/transfer reference | Stable short server-allocated persisted reference or explicit unnumbered state; ASCII digits | H, B | No UUID/UI-generated fallback; authorized technical IDs remain technical fields; preserve external references |
| A59 | Q04, H01 | P1 | Build/install exact artifact; dependency/license/secret/signature gates and invalid update | Verifiable artifact/SBOM/provenance/hashes, fail gates, no untreated high/critical finding in reviewed scope | U, V | Old scans/different source cannot qualify artifact; no absolute security guarantee |
| A60 | Q05 | P1 | Representative monitored 30-60 day pilot with backup/restore/upgrade/rollback/rotation/alert drills | Service/incident/measurement records, no open core P0/P1, release decision and support readiness | B, V, E | Time alone is insufficient; data loss/authorization breach stops expansion and reopens cause gate |

### Required cross-cutting subcases

These remain part of A01-A60, not extra accepted scenarios. A targeted portable regression never closes its entire Linux/service gate.

- A01: bind every artifact/runtime input, including untracked inputs, to a manifest; reinstall in a clean worker. Exclude caches and secrets.
- A04/A55: bounded KDF concurrency with valid/invalid login load, independent health probes, event-loop delay, p95, peak RSS, and queue rejection. `force_password_change` must deny ordinary access until the authorized change flow; repeat A09/A11.
- A14: real UNIX socket across allowed/disallowed UID/group and a simulated stolen service credential. Distinguish credential protection, socket modes, and kernel identity. Agent/socket loss must deny mutation without local API execution. Bind privileged qualification to an approved source manifest, verified archive/extracted tree, and receipt; a supplied digest alone is not approval.
- A18: race snapshot checksum against generated files; kill writers during domain rename and account/principal creation; recover complete prior/new revisions. Verify UID uniqueness across processes.
- A19/A20: inject chown/rename/fsync/ENOSPC failures. Compare bytes/mode/UID/GID after rollback, clean only task-owned temporary data, and leave no partial users/directories/units. Prove candidate files never occupy live paths before validation, including external service restart.
- A21/A28: exercise the actual reconcile/rollback CLI through its authenticated agent channel with missing socket/unauthorized identity and recovery. Substitute HTTP calls do not prove CLI behavior.
- A22: externally change an owned config while desired checksum stays fixed. Reconcile without force must detect/repair or explicitly deny drift; repeat after restart. Never modify unmanaged files.
- A24/A54: scheduler-driven retention for metrics, expired sessions, and attempts with fixed time boundaries, worker restart/reboot, and verifiable archived audit records. Manual prune alone does not prove scheduling.
- A29: actual EN/AR form login without injected cookies, MFA when required, redirect, localized inline failure, page/network errors, and every advertised action route. Missing endpoints cannot become local success messages.
- A30: empty store and one-account store; fixtures never mix with real state. No invented generation/footprint/TLS/healthy status. Realtime starts unknown/connecting and becomes connected only with connection evidence. Two accounts cannot share an arbitrary first-account context.
- A40/A47: upload/download/backup beyond memory budget with slow clients, cancellation/disconnect, measured peak RSS, bounded temporary storage and cleanup time. Enforce limits during streams even with absent/false length; cover copy/move/compress/extract and concurrent quotas.
- A53: after failed health, rollback, and worker restart, a second valid upgrade must complete without manually deleting a pending row. Record checkpoint/lock recovery and data identity.
- A56/A57: actual header/value edges with declared tolerance; no document overflow at 390x844. Large tables need labeled keyboard-reachable scroll wrappers. Cover numeric/unit fragments, email/path/LTR messages, no Arabic letter spacing/header clipping, axe zero serious/critical for EN/AR core surfaces, progressbar names, header scope, contrast, landmarks, Tab/Shift+Tab/Escape and modal focus return. Retain manual review.
- A58: failed apply restores the last observed generation badge; no client reference allocation. File creation uses authorized account/directory; no fixed fixture path or CSRF fallback.
- A29/A55/A59: verify hashed JS/CSS, immutable policy, update invalidation, working CSP, actual negotiated br/gzip bytes, and uncompressed clients. Authenticated HTML/user data stay out of public caches. Declare whether installed-footprint measurement includes required runtime and distinguish installed/archive size.

## 4. Gate closure

| Gate | Scenarios | Required closure | Blocked claim/action |
|---|---|---|---|
| G0 | A01-A03 | Reproducible baseline and correctly classified evidence | Completion inferred from tool/test counts |
| G1 | A04-A17 | All privilege/identity/agent/file P0 cases, including HTML/WS | Production/customer data use |
| G2 | A18-A25 | Consistent apply/recovery/jobs/audit/identity under failure | DB row treated as job/generation success |
| G3 | A26-A35 | Artifact install and actual tenant/site UID/cgroup evidence | Untested OS/isolation support claims |
| G4 | A36-A41 | Every advertised release service works and fails safely | Disconnected capability presented as ready |
| G5 | A42-A46 | Real mail/xMail isolation and abuse checks | Synthetic delivery/JSON substituted for IMAP |
| G6 | A47-A53 | Restorable backup, actual transfer, recoverable upgrade | Customer-host changes without proven recovery |
| G7 | A54-A60 | Current budget/UX/accessibility/release/pilot evidence | Unmeasured capacity/compatibility claims |

A later gate cannot compensate for an earlier failure. Public production readiness requires G0-G7 within the declared release profile. Optional-service exclusion applies only to profiles not advertising that service. A limited internal release does not change overall readiness.

## 5. Performance protocol

### 5.1 Fixed measurement profiles

| Profile | Initial fixture resources | Services/load | Purpose |
|---|---|---|---|
| P-small | 1 vCPU, 1 GB RAM, SSD >=20 GB plus declared fixture space | Panel, Nginx/Apache, ondemand PHP-FPM, MariaDB, 10 low-activity accounts; measure mail/DNS/FTP additions separately | Minimum/idle evidence, not every workload |
| P-medium | 2 vCPU, 4 GB RAM, 80 GB SSD | 100 accounts, first 1 then 5 domains/account; declared services | State/concurrency/backup/reconcile scaling |
| P-capacity | 4 vCPU, 8 GB RAM, 160 GB SSD | 500 accounts, 1 then 5 domains/account; idle/distributed/noisy-neighbor load | Capacity and admission limits |

These are initial test fixtures, not proven product requirements. Record actual disk/IOPS/throughput, filesystem/quotas/controllers, kernel/distribution/service/runtime versions, swap, VM contention. Do not compare different storage/service profiles as code improvements or claim 500 active sites fit 1 GB RAM.

### 5.2 Procedure

1. Install one fixed artifact on a clean VM, reboot, retain sanitized profile/seed.
2. Warm up 5 minutes; sample idle every 5 seconds for >=15 minutes. Separate API/agent RSS/CPU from hosting services and OS.
3. For core reads, warm up 1 minute then measure >=10 minutes, 3 repetitions, concurrency 1/5/20. Report requests/sample count/errors, median/p95/p99/max.
4. Measure single-account edit, domain addition, plan affecting 100 accounts, and full reindex; separate queue/render/test/switch/reload/verify, changed bytes, restarts, and neighbor impact.
5. Stream >=2 GB on a storage-capable profile, including slow client/disconnect/cancel; record peak RSS, temporary files/bytes, cleanup duration.
6. Stress CPU/memory/IO/processes independently then together; compare neighbor canary before/during/after. Separate effective cgroup caps from hardware/network ceilings.
7. Run 24-hour rotation/rollup/deletion/reconnect/scheduler/restart exercise before pilot; compare memory/history/fd count in equivalent windows.
8. Retain recalculable raw results; do not discard slow runs without a recorded cause.

### 5.3 Budgets and proposed targets

| Metric | Limit | Interpretation |
|---|---|---|
| API idle RSS | <=60 MB | Process budget, not all host services |
| Agent idle RSS | <=50 MB | Includes default retained history |
| Idle CPU/process | <0.5% | 15-minute mean plus peak; no busy polling |
| Initial browser JS | <=200 KB gzip | Measure artifact, not source size |
| Added route chunk | <=60 KB gzip | Count shared chunks once |
| Installed panel | <=200 MB | Include panel dependencies/assets; declare required runtime and OS-service boundary |
| Core local API read p95 | <=250 ms, 5 clients, P-small | Proposed dataset-defined target; exclude host/network operations |
| List read p95, 100 accounts | <=500 ms, 20 clients, P-medium | Proposed bounded-pagination target; no per-request whole-tree rescan |
| Validated job acceptance p95 | <=500 ms, 5 clients, P-small | Proposed enqueue target, not completion time |
| Browser progress-event p95 | <=1 second | Proposed accepted-event-to-DOM target; measure catch-up separately; heartbeat is not progress |
| Single-domain reconcile p95 | <=10 seconds, P-medium | Proposed warmed real-syntax-test target; exclude ACME/install/backup |
| Unexpected core request errors | 0 in declared workload | Not a production availability claim; test expected denials/quotas separately |
| Memory/handle retention | No unexplained equivalent-window growth | Investigate over 24 hours with GC observations; sparse samples are insufficient |

Proposed targets are not achieved results or SLAs. Review first real baselines; requirement changes need measurements and an engineering rationale, not an increased limit merely to pass. Measure the 500-account curve separately. An exceeded mandatory budget requires correction or an openly revised requirement before G7 closure.

## 6. Qualification work packages

| Package | Responsibility | Work and completion evidence |
|---|---|---|
| Q01 | Systems/performance and backend | Delta metrics, bounded retention, offsets/indexing; raw A33/A54/A55 baselines and unsupported-controller disclosure |
| Q02 | Frontend/UX and QA | Actual workflows, RTL/ASCII/alignment, keyboard/screen reader, persisted references; real-browser A29/A30/A56/A57/A58 geometry/traces/manual review |
| Q03 | QA/release | Separate U/H/B/V/E, disposable provisioning/cleanup, independent oracles/faults; per-scenario receipts, explicit blocked prerequisites |
| Q04 | Release/security | Bind source/artifact/SBOM/provenance, authentication and dependency/license/secret gates; same-artifact A26/A28/A53/A59 with corrupt/incompatible rejection |
| Q05 | Operations and QA/backend | Monitored pilot, incidents, restore/upgrade drills, rollback/support decision; A60 over 30-60 days |

These are engineering responsibilities, not evidence of completion. Security prerequisites must not wait for a later performance phase.

## 7. CI and evidence

Fast checks cover typechecks, unit/policy/contracts, and browser/build syntax. UI changes add real browser smoke; host/lifecycle changes add relevant disposable Linux qualification. Release candidates require the exact artifact on every advertised OS/profile; an older nightly cannot qualify a newer artifact.

Privileged qualification requires an approved source/archival manifest, verified extracted tree, and matching receipt before any host action. Never trust a caller-supplied digest alone. Root VMs use synthetic data and confined paths; no production secrets in untrusted PRs. Image/package provisioning is explicit pipeline work, not a unit-test side effect. Retain exits/stdout/stderr safely; diagnose flakes and preserve initial failures.

Proposed receipt, not an executed result:

```json
{
  "schemaVersion": 1,
  "scenario": "A31",
  "packages": ["H05"],
  "gate": "G3",
  "status": "not_run",
  "sourceRevision": null,
  "workingTreeManifestSha256": null,
  "artifactSha256": null,
  "testDefinitionSha256": null,
  "environment": {
    "kind": "linux-vm",
    "profile": null,
    "imageDigest": null,
    "os": null,
    "kernel": null,
    "runtime": null,
    "services": {},
    "filesystem": null,
    "cgroupControllers": []
  },
  "startedAtUtc": null,
  "finishedAtUtc": null,
  "preconditions": [],
  "observations": [],
  "artifacts": [],
  "failure": null,
  "reviewer": null,
  "redactionVerified": false
}
```

Each artifact needs an authorized location, SHA256, media type, and retention/access policy. Observations record expected/measured values, units, and independent source such as PID/UID/cgroup, file digest, or external probe. No credentials/cookies/keys/customer mail. Evidence hashes/CI IDs are technical traceability, not customer references.

Proposed retention: sanitized PR results 30 days, nightly evidence 90 days, supported-release evidence through end of support plus 180 days. Approve storage/access costs before adoption; incidents may require longer preservation. Private diagnostics must not enter public artifacts.

## 8. Pilot and launch decision

Before pilot, close G0-G6, collect initial A54-A59 evidence, exercise recovery, and publish supported OS/services/PHP and exclusions. Start synthetic accounts, then explicit limited participants with support and rollback. A pilot cannot waive P0 security failures.

Over 30-60 days record representative load, resource/release changes, jobs, backup age, alerts/auth failures, file/DB/account restoration, remote disaster recovery, successful and failed upgrades. Compare independent site/mail/DNS probes to panel metrics; deliberately lose monitoring to distinguish silence from health.

Review actual accounts/load, incident impact and recovery times, root causes/fixes, unresolved blockers, and candidate-artifact coverage. No incidents alone is insufficient without active probes/drills. Data loss or tenant leakage stops expansion and reopens the cause gate. Engineering and operations review evidence, limitations, support readiness, and independently usable runbooks. Describe only the proven scope; deferred capabilities remain clearly unavailable.
