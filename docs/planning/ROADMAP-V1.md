# xPanel v1 implementation roadmap

Status: local implementation plan. This document is not acceptance evidence or release authorization.

## 1. Delivery objective and corrected baseline

The first delivery is an immutable lab candidate with the same complete hosting slice qualified independently on Ubuntu 22.04, Ubuntu 24.04, AlmaLinux 9, Rocky Linux 9 and CentOS Stream 9. A failed, blocked or unrun profile blocks that delivery. Production rollout is a separate decision.

Both Classic and V2 continue in parallel against their approved designs. Qualification controls whether an operation is available; it does not justify deleting approved components, reducing route coverage or replacing detailed screens with generic placeholders.

Repository findings distinguish implementation, runtime readiness and independent acceptance:

- The navigation inventory currently contains 203 canonical pages and 14 aliases. The 48 admission patterns are not the product scope or a count of accepted capabilities. Generate inventory from source rather than maintaining duplicated prose totals.
- Static delivery evidence is empty, but host qualification can currently promote tools using readiness probes. Therefore the claim that only two pages can render is not established. Host probes must become readiness inputs rather than acceptance evidence.
- The acceptance matrix contains 60 scenarios: 34 P0 and 26 P1. The original mapping has 21 missing unique scenario harness paths. Existing substantive tests must be mapped by assertion and oracle before adding genuinely absent coverage. A path or test name never proves execution.
- Real Linux executors already exist. Quota enablement, target-bound observation, lifecycle recovery and DNS backend alignment are concrete gaps. MariaDB provisioning is required by database operations, not universally by every account creation.
- Complete create-account acceptance includes a system user, home, vhost and DNS zone. DNS cannot be postponed while declaring that capability accepted.
- Optional MFA, scoped bearer credentials and the current delegated-session authority model remain. Address demonstrated durability, configuration and isolation gaps instead of imposing target-factor enrollment, rigid IP binding or mandatory token pepper without a threat-model decision.
- The general signed installation/update path needs qualification independently of any successful lab activation.

## 2. Parallel ownership and integration

Use one writer per owned module and one integrator for shared entrypoints, publication and native execution. Preserve concurrent changes. Claim exact files before editing; submit bounded integration requests for reserved entrypoints. Do not switch the shared checkout branch or commit unrelated dirty work.

| Stream | Responsibility | Integration boundary |
| --- | --- | --- |
| Evidence | Detached targets, reports, receipt verification and trusted loading | Catalog changes by scoped agreement |
| Acceptance and lanes | Semantic scenario mapping, validators and the prepared lane foundation | Preserve existing required CI/browser checks |
| Account lifecycle | Durable operation identity, checkpoints, retries and honest partial effects | One reconciler writer; entrypoints through integrator |
| Host services | Quota, DNS, database prerequisites and independent observation | One installer writer; no concurrent reconciler edits |
| State and audit | Recoverable projections, operation outcome and serialized audit append | Preserve identity/security authority and writer mutex |
| Release | Source/version provenance, archive trust, sidecar, install/upgrade contracts | No activation or deployment by workers |
| Themes | Complete Classic/V2 components, controllers, accessibility and translations | Existing theme ownership remains in force |

Workers implement independently; integration and host writes are serialized. Reuse valid exact-input evidence. Record actual states and blockers rather than estimated completion percentages. One heavy lane runs per physical host; independent hosts may qualify profiles concurrently.

## 3. Evidence and runtime contracts

### Detached evidence

1. Compute a versioned source identity from reviewed source/build/test inputs, including lockfile and acceptance inputs. Capture identity before and after a run. Different fingerprint algorithms are never interchangeable.
2. Build and hash the immutable release artifact. Qualification records source identity, artifact digest, runtime/dependency identity and the exact profile.
3. Store `EvidenceBundle v1` outside source and the executable artifact. It contains the existing `VerificationTarget`, `CapabilityEvidence` rows and a hash-indexed receipt/report manifest. Recording evidence must not change the source or artifact being qualified.
4. Validate underlying report semantics, expected cases, counts, outcomes, execution class and cleanup. Exit zero plus report existence is insufficient. Reject mixed sources/profiles, corrupted reports, duplicate or missing results and skipped required proof.
5. Load the detached bundle from an operator-controlled path that the API service cannot write. Verify an externally configured digest, ownership and safe file paths. Missing or invalid evidence fails closed. No separate evidence service is introduced.

Existing primitive VM results and fake-host browser tests keep their limited meaning. They cannot be automatically converted into full capability acceptance.

### Admission and execution

Effective availability is release acceptance AND current-host readiness AND caller authorization. Pure health probes never create `verified` evidence. Preserve the existing catalog injection boundary and pure assessment functions.

Every declared profile must independently satisfy the required environments for each delivery tier. Never combine a Linux pass from one distribution with a browser or external pass from another. Integrate changed admission behavior on a candidate before lab activation; list operations that become unavailable pending real evidence.

Account operations use server-derived account/operation scope, durable idempotency keys and explicit failed/unknown outcomes. Observe account identity, UID/GID, home, state revision, selected generation, service state and workload response. Merely finding an IP on an interface is insufficient.

## 4. Delivery waves

### Wave 0: claims, fixtures and resources

- Register owners and preserve concurrent source. Review and reuse existing lane and native-runner preparation.
- Admit a disposable fixture for each profile with systemd, cgroup v2, quota-capable storage, real dependencies, two tenant canaries, independent observation and verified recovery.
- Reuse available infrastructure. New paid resources are not assumed. Missing fixtures remain explicit blockers.
- Measure free space and load before heavy jobs. Do not add large files or VM disks where local free space is below the required minimum. Keep evidence small and cleanup reversible.

Exit: ownership and the five-profile fixture matrix are explicit; target/receipt contracts are testable.

### Wave 1: executable evidence and a bounded capability

Implement `target`, `record` and `verify`, semantic report validation and source-bound receipt aggregation. Repair the scenario mapping against real assertions while retaining unaccepted status until execution.

Start with `server-information`: compare the required OS measurements to the capability criterion using an independent observer, authorized access and the actual interface. One-profile results are intermediate development evidence. Delivery requires all five profiles.

Exit: the full artifact-to-receipt-to-admission chain works and rejects invalid evidence.

### Wave 2: the hosting slice

- Quota: observe filesystem support, execute supported idempotent enablement and enforcement, and never report enabled from metadata alone. Do not blindly remount a shared filesystem.
- DNS: align installation with the existing supported adapter, validate zones and observe served content and serial independently.
- Lifecycle: persist operation identity and progress across desired state, native effects and principal establishment. Protect retries, conflicts, crashes and unknown cleanup. Never blindly delete an account to compensate an ambiguous result.
- Reconciliation: validate staged syntax before effects where feasible; account for native tests requiring real identities. Journal effects before execution and report retained side effects honestly after later failure.
- Observation: wire actual health probes and target-bound account/service/workload receipts.
- State: recover authoritative JSON and affected derived SQL projections under writer exclusion before dependent reads. Preserve identity/security tables, revocation rules and permanent mutex identity.
- Audit: persist selected operation/audit intent and outcomes; serialize hash-chain append. A file sink alone is not atomic mutation evidence.
- Database: preserve existing administrative credentials, provision protected access idempotently and qualify database operations and tenant denial without broad new executor grants.

Required journey on every profile: create account -> user/home/vhost/DNS -> real PHP response -> UID/cgroup/quota proof -> suspend/unsuspend -> recoverably terminate. Include duplicate request, failed configuration, timeout after effect, process interruption, cross-tenant denial and unknown cleanup.

Exit: the same complete journey and failure cases pass independently on all five profiles.

### Wave 3: qualified candidate and service completion

Complete version/source provenance, the Ed25519 publisher sidecar and trust provisioning while retaining inner HMAC archive verification. Reconcile install/runtime layout and installation receipts; make CLI promises match actual commands.

Continue files, cron, TLS renewal, FTP/terminal, mail/xMail, backup/restore, transfer and cPanel import as independently qualified packets. Theme completion continues without reducing the approved component inventory to the qualified route subset.

Exit: a frozen candidate, matching detached evidence, an explicit capability/profile matrix and an honest remaining-work list.

### Wave 4: v1 closure

Close the acceptance matrix, performance budgets, declared install/upgrade/restore profiles, operator documentation and migration guide. Preserve AGPL-3.0-only and existing privacy/review controls.

Estimate completion after fixture readiness and the first complete profile run, using measured setup, execution, recovery and repair time plus real host parallelism. A worker count is not a multiplier for serialized host operations. Pilot evidence remains a real elapsed-time and operational requirement; no synthetic substitute.

## 5. Verification and delivery gates

- Fast: affected tests first, then the complete non-slow portable suite, under 300 seconds combined. Cases at or above 2 seconds require the slow tag and fixture/layer rebuilding when touched. An initial slow budget must be measured and established; the proposed value 3 is not accepted evidence.
- Full: once per frozen release candidate, including technical slow cases, on the production SQLite engine. Use prebuilt state and transaction resets for ordinary DB tests; retain separate processes/connections for genuine concurrency proof.
- Preserve mandatory repository merge/browser checks. Validate report content and hashes, not only commands and output paths. Missing native prerequisites are blocked or not-run, never passed.
- UI implementation checks cover affected Arabic/English phone/desktop states, RTL/LTR, ASCII digits, content-edge alignment and 8/16/24/32 spacing. Preserve assertions and approved components.
- Visual implementation acceptance remains separate from deployment. Deployment runs no screenshots, visual inspections or geometry gates; preserve exact-version technical smoke, authentication, recovery and data-integrity checks.
- Whole-machine recovery tests run on disposable environments. Do not restore a pre-boundary DB snapshot after normal writers have crossed a committed activation boundary.
- Final evidence must identify passed/failed/blocked/not-run for every profile, actual source/artifact identities and retained receipts. The first qualified-lab milestone requires 5/5 complete passes plus recovery and cleanup proof.

This roadmap records intended work. Implemented code, focused checks, full lanes, native qualification and release acceptance must be reported separately.
