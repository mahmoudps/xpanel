# Operational runbooks and release governance

These procedures describe the current source contracts and the remaining acceptance requirements. They are not a production-readiness certificate. Read [status](../STATUS.md), [testing](../TESTING.md), and the [acceptance matrix](../planning/ACCEPTANCE-MATRIX.md) before operational changes. A metadata response or passing structural test does not prove a live hosting operation.

No credential values belong in commands, process arguments, examples, logs, or receipts. Supply secrets through protected files or standard input, and preserve existing credentials until a reviewed rotation completes. Use a protected backup location with an approved recovery procedure; never publish runtime state or backup contents.

## Runtime paths and command boundary

| Item | Source default or installed path | Contract |
|---|---|---|
| Release tree | `/opt/xpanel` | Source-mode Node entrypoints; no required `dist/index.js` |
| API entrypoint | `/opt/xpanel/apps/api/src/main.ts` | Unprivileged `xpanel:xpanel` systemd service |
| Agent entrypoint | `/opt/xpanel/apps/agent/src/main.ts` | Separate Linux root service, group `xpanel-agent` |
| Control database | `/var/lib/xpanel/control.db` | Includes identity/session/audit state; installer requires `xpanel:xpanel`, mode `0660` |
| Desired state | `/var/lib/xpanel/state` | Cannot substitute for identity database backup |
| Generations | `/var/lib/xpanel/generations` | Retain together with corresponding desired state and database |
| Logs | `/var/log/xpanel` and systemd journal | Sanitize diagnostic exports |
| Shared runtime environment | `/etc/xpanel/runtime.env` | Root-owned configuration, installed group `xpanel`, mode `0640` |
| API environment | `/etc/xpanel/api.env` | Origins, trusted proxies, bind host/port; preserve operator settings |
| Agent credential | `/etc/xpanel/agent.token` | Installer creates/preserves protected credential, not inline configuration |
| Server sealing secret | `/etc/xpanel/server.secret` | Required for protected authentication material; preserve with identity recovery |
| Agent socket | `/run/xpanel/agent.sock` | Runtime directory `0750 root:xpanel-agent`; kernel peer identity and service credential checks |
| Account file helper | `/opt/xpanel/bin/xpanel-account-files` | Native confined helper; absence must fail closed |
| Account backup work/download roots | `/var/lib/xpanel/backups/work`, `/var/lib/xpanel/backups/downloads` | Defaults in `packages/lifecycle/src/backup/plan.ts`; a plan does not prove a connected production executor |

The actual administrative CLI is Node running `apps/api/src/main.ts`, implemented by `apps/api/src/cli.ts`. Its commands are `status`, `reconcile [--force]`, `rollback <generation-id>`, `reindex`, `init-root --password-stdin`, `reset-password <username> --password-stdin`, and `disable-2fa <username>`. Administrative verbs require the operating-system root user on Linux. Reconcile/rollback require an authenticated separate agent. There is no implemented general `xpanel-ctl` command suite for backup, vault, certificate, queue, or release operations.

## Runbook 01: Installation

**Runbook ID**: `install`

Targets: A26-A28, A59.

### Preconditions

- Use a disposable, dedicated Linux host and a reviewed, authenticated release. Bind the approved source, archive hash, extracted-tree inventory, and verification receipt before privileged code runs. A caller-supplied SHA256 alone is insufficient. Do not run privileged qualification scripts until their source guard and environment are independently verified.
- Preinstall the exact Node version in `.node-version`; review locked production dependencies and required native builds. The installer does not download the Node runtime or install workspace dependencies for you.
- Review `scripts/install.sh`, `deploy/systemd/`, OS/package repositories, available ports, storage, cgroup v2 controllers, and quotas. Distribution package plans are not qualified support claims.

### Execution Steps

1. Verify artifact authentication and exact file inventory before extraction/provisioning. Review production dependency/native-addon inputs and record their hashes. Place the verified tree at `/opt/xpanel` with trusted ownership and no untrusted writable ancestors.
2. Inspect the non-mutating installer plan from the reviewed tree, for example `bash scripts/install.sh --dry-run --engine=apache --apache-mpm=itk --php=8.3`. This is a plan, not installation proof.
3. In the approved maintenance window, invoke that reviewed installer with the selected options and without `--dry-run`. Its privileged path requires Linux/systemd, pinned runtime and installed dependencies, Apache itk, cgroup/quota preconditions, and stopped existing panel services. Back up existing configurations first; retain the install journal and adjacent configuration backups. Optional mail/DNS/FTP/MariaDB installation requires the corresponding `--with-*` option.
4. Review created identities, permissions, `/etc/xpanel/runtime.env`, `/etc/xpanel/api.env`, units, native peer listener/helper prerequisites, and SQL adapter configuration. The script enables units but does not start them. Configure approved HTTPS origins and proxy trust, then provision root as described below.

### Verification Oracle

- Artifact/installed entrypoint hashes match; API runs as non-root, agent separately as root; no development dependency substitution.
- `control.db` is `0660 xpanel:xpanel`; secret/config files follow protected source policy; runtime socket identity/modes match the units and kernel peer checks.
- Start only after the reviewed prerequisites are satisfied; independently probe health, authentication denial, services, reboot recovery, and actual tenant UID/cgroup/quotas. Enabling systemd units or successful dry-run output does not close A26-A28.
- Installer source parses Ubuntu 22.04/24.04 and Enterprise Linux 9/10 family plans, while the privileged Apache-itk requirement can reject a plan. No broader distribution/architecture qualification is implied.

## Runbook 02: First login and MFA

**Runbook ID**: `first-login-and-mfa`

Targets: A06, A09-A11, A29-A30.

### Preconditions

- Verified local installation and protected credentials/configuration; trusted HTTPS origin and explicit proxy configuration.
- No default root password is assumed. An authorized OS-root operator controls initial provisioning without exposing a password in terminal history, process arguments, or diagnostics.

### Execution Steps

1. Provision root once through `node /opt/xpanel/apps/api/src/main.ts init-root --password-stdin`, feeding a single password line from a protected input source. Do not use inline-password compatibility modes. The command sets the forced-password-change flag; it does not enroll MFA or complete setup.
2. Start the verified services only after configuration/native prerequisites are reviewed. Use the actual `/login` form over HTTPS; complete the authorized password-change and MFA enrollment flows. Do not inject cookies or bypass MFA to make onboarding appear successful.
3. Protect the TOTP seed and returned single-use recovery codes offline. Count and behavior must follow the current authentication implementation; do not assume a fixed count from an older runbook.
4. Complete the available setup workflow and verify actual persisted configuration. If a required UI/adapter is unavailable, report blocked and keep the administrative gate; do not fabricate bootstrap URLs or completion records.

### Verification Oracle

- Missing/old credentials do not authenticate; forced-change/MFA restrictions hold for HTML, REST, and WS.
- Password change/reset revokes sessions/tokens as required by the credential policy; recovery codes and consumed TOTP windows cannot be replayed.
- Cookies, CSRF, expiry/logout/revocation, localized inline login failure, and unauthorized HTML redirects are observed in a real browser.
- Emergency `reset-password` or `disable-2fa` is a sensitive audited local recovery operation, not an onboarding shortcut. Require explicit authorization, restore strong authentication, and review revocation/audit effects before reopening administration.

## Runbook 03: Secret rotation

**Runbook ID**: `secret-rotation`

Targets: A09-A10, A14-A17, A25.

### Preconditions

- A consistent verified backup of the control DB, desired state, configuration, and required decryption/sealing material; protected off-host recovery access.
- Inventory actual consumers of `/etc/xpanel/agent.token` and `/etc/xpanel/server.secret`. There is no implemented `vault rotate-master-key` CLI or atomic global secret migration command.

### Execution Steps

1. Quiesce affected services/writers in an approved maintenance window; preserve credential/config metadata and recovery material without printing values.
2. Prepare and test an explicit migration for the relevant credential and its consumers. Agent credential changes must update both authenticated peers consistently.
3. Do not replace `server.secret` blindly: encrypted authentication material may become unreadable. Decrypt/reseal or controlled factor recovery must be designed and tested before activation. If this cannot be proven, rotation is blocked.
4. Apply only the reviewed procedure with protected files and atomic writes; restart only affected services, invalidate compromised sessions/tokens, and verify permissions and audit events.

### Verification Oracle

- New credentials work only for intended principals; retired credentials fail; no bypass when a secret is missing/unreadable.
- Existing protected authentication material remains recoverable under the approved migration, and revoked sessions/tokens do not revive.
- Sanitized scans of state/DB/log exports find no exposed secret values; recovery is independently demonstrated. A changed file timestamp is not rotation proof.

## Runbook 04: Backup

**Runbook ID**: `backup`

Targets: A25, A47-A48.

### Preconditions

- Identify the backup scope: control-plane disaster recovery differs from tenant files/SQL/mail backup. Declare consistency, encryption, destination, retention, and independent verification.
- Confirm space, source permissions, and a connected confined executor before invoking any account backup workflow. The lifecycle package's plan defaults do not prove production capture/upload wiring.

### Execution Steps

1. For control-plane recovery, quiesce writers or use a reviewed consistent snapshot/SQLite-backup mechanism. Preserve `/var/lib/xpanel/control.db` together with the authoritative `/var/lib/xpanel/state`, required generations, `/etc/xpanel`, relevant managed-service configuration, exact release identity, and native build inputs. Do not copy a live SQLite file alone and ignore its WAL.
2. Store protected recovery copies outside the failure domain. Select an operator-approved destination; no universal control-plane backup directory is defined by the source.
3. For account backups, inspect `packages/lifecycle/src/backup/plan.ts`: work and download defaults are `/var/lib/xpanel/backups/work` and `/var/lib/xpanel/backups/downloads`; account-directory and remote destinations have separate contracts. Validate actual streaming, per-account identity, SQL dumps, mail parts, manifest hashes, and cleanup.
4. Inspect the deployed API/worker integration before use. A destination/schedule/snapshot metadata record or client-supplied fixture content is not a completed backup. The production capture path must reject a missing confined snapshot executor. Keep unsupported capture/upload/encryption claims blocked.

### Verification Oracle

- Verify an independently readable artifact with expected contents/checksums and declared consistency; restore on a separate disposable target.
- Cover datasets exceeding memory budget, remote interruption/retry, ENOSPC, retention, cancellation, and secret-safe encryption/key recovery where advertised.
- An index, database names, successful metadata response, or configured destination does not close A47/A48. No `xpanel-ctl backup` command is supplied because none is implemented.

## Runbook 05: Restore and disaster recovery

**Runbook ID**: `restore-and-disaster-recovery`

Targets: A25, A49-A50.

### Preconditions

- Verified artifact, manifest, required protected keys, source release/schema identity, and a disposable recovery target.
- Review `packages/lifecycle/src/backup/restore.ts` and archive guards; prove a confined production restore executor. The API granular-restore path fails closed when this executor/artifact is missing.

### Execution Steps

1. Authenticate and inspect the archive before extraction: paths, links, entry/byte limits, component hashes, overwrite diff, account identities, and consistency policy. Reject traversal, symlinks, bombs, corruption, and wrong keys before live effects.
2. Restore the control plane as a consistent set using the reviewed external backup procedure, preserving identity DB/sealing material and revocation state. Do not use `reindex` as password/MFA recovery.
3. Restore account components only through approved confinement/identity adapters and a reversible overwrite plan. Validate UID/GID remapping, SQL/mail/DNS content and unrelated-account preservation. If the connected executor is absent, stop with blocked status; do not write tenant files directly as API/root fallback.
4. Rebuild only the derived index when appropriate through the actual `reindex` CLI, then reconcile through the authenticated agent after reviewing the desired/live diff. Keep the source VM unavailable during full disaster recovery testing.

### Verification Oracle

- Independent files/rows/mail/DNS/authentication probes match the backup; revoked credentials remain revoked; unrelated tenants are unchanged.
- Record RPO/RTO using an independent clock and demonstrate recovery keys survive source loss.
- Test interruption and rollback of overwritten files. A parsed manifest or restored state JSON alone is not successful service recovery.

## Runbook 06: Upgrade

**Runbook ID**: `upgrade`

Targets: A26, A53, A59.

### Preconditions

- Exact approved artifact, authenticated manifest, dependency/native inventory, schema compatibility, free space, quiescent jobs/transfers, and a verified recovery snapshot.
- Review `scripts/package-release.mjs` and `packages/lifecycle/src/upgrade/`. Production host/filesystem/reconciler/migrator/health/history ports must be explicitly connected and qualified. An API-created upgrade row alone is insufficient.

### Execution Steps

1. Verify release archive authentication before extraction and verify the extracted exact tree, including unexpected files. The packager uses HMAC-SHA256 with a separately protected real key; it is not an Ed25519 public-signature release system. Do not use a development/default key as release authentication.
2. Preserve the previous verified release and a consistent control DB/state/config/key snapshot. Review migration compatibility and source/artifact normalization separately from raw input identity.
3. Execute only a reviewed qualified upgrade integration. Its state machine covers precheck, snapshot, stage, migrate, switch, health-check, and rollback. Do not invent a `current` symlink layout or general upgrade CLI not supplied by the installed system.
4. Verify the actual API/agent version/hashes and independent host/tenant probes after activation. If required production ports or safety guards are absent, the automated upgrade remains blocked; a documented operator maintenance procedure needs its own reviewed recovery proof.

### Verification Oracle

- Corrupt/unauthenticated/incompatible artifacts fail before activation; tenant identities, quotas, data, and schema safety survive.
- Inject health failure and worker interruption at each phase on a disposable VM, verify restored prior release/generation, restart recovery, and a subsequent successful upgrade.
- Record actual observations rather than interpreting a pending/succeeded DB row as host proof.

## Runbook 07: Rollback

**Runbook ID**: `rollback`

Targets: A19-A21, A53.

### Preconditions

- Verified known-good configuration generation or release plus compatible consistent state/identity recovery snapshot; approved maintenance window.
- Distinguish configuration rollback from control-plane release/schema rollback. A generation alone is not a backup of deleted account data or credentials.

### Execution Steps

1. Inspect the candidate/current generation and live file/service difference. Preserve all required data/configuration before mutation.
2. Configuration rollback uses the actual `node /opt/xpanel/apps/api/src/main.ts rollback <generation-id>` command with a positive existing generation ID, OS-root authorization, and authenticated separate agent. It must fail closed when the agent is unavailable.
3. Release rollback follows the reviewed upgrade ports/procedure and its saved release/state/schema compatibility plan; there is no general `upgrade rollback` CLI in this source. Never reactivate a known security-vulnerable release for public access.
4. Run independent syntax/service/tenant probes and reconcile observed state with the recorded active generation. Preserve failed attempts and recovery diagnostics.

### Verification Oracle

- Actual bytes/modes/UID/GID and services match the restored generation; unrelated files and tenant data stay unchanged.
- Forced reload/probe failure restores a consistent previous state; a rollback event or generation row alone is insufficient.

## Runbook 08: Disk-full recovery

**Runbook ID**: `disk-full-recovery`

Targets: A21, A32, A48, A53; F02.

### Preconditions

- Confirm block or inode exhaustion and affected filesystems; preserve sanitized failure/journal evidence. Do not begin destructive cleanup from a guessed directory.

### Execution Steps

1. Read actual usage and service errors:

   ```bash
   df -h / /var/lib/xpanel /home
   df -i / /var/lib/xpanel /home
   systemctl status xpanel-agent.service xpanel-api.service --no-pager
   ```

2. Stop new work where necessary; identify task-owned temporary artifacts and approved expired retention data. Preserve current/rollback generations, consistent DB/WAL, identity keys, backups, and audit retention. There is no implemented general clean-staging/log-prune/database-purge CLI.
3. Recover capacity through reviewed retention/storage procedures; do not recursively delete arbitrary state, account files, or journals. Restore ownership/modes if explicitly repaired.
4. Inspect interrupted reconciliation/upgrade/backup state before restarting workers. Run the qualified recovery path and independent probes; `reindex` repairs only derived indexing and must not hide lost identity/audit state.

### Verification Oracle

- Record restored free blocks/inodes and safe admission thresholds for the actual profile; subsequent approved operations succeed without ENOSPC.
- Interrupted work either recovers or reports an explicit safe failure; no false success, missing audits, abandoned owned artifacts, or corruption.

## Runbook 09: Agent outage triage

**Runbook ID**: `agent-outage-triage`

Targets: A14, A20-A25; F01.

### Preconditions

- Confirm the actual connection/service symptom. A disconnected UI indicator alone does not identify socket, credential, kernel-addon, permissions, or reconciler failure.

### Execution Steps

1. Inspect services, bounded sanitized logs, and socket metadata:

   ```bash
   systemctl status xpanel-agent.service xpanel-api.service --no-pager
   journalctl -u xpanel-agent.service -n 100 --no-pager
   stat -c '%a %U:%G %n' /run/xpanel /run/xpanel/agent.sock
   ```

2. Compare installed units, native peer-listener build, helper identity/hash, dedicated groups, DB accessibility, credential-file permissions, and expected runtime paths. Never print credential files or widen the socket to world access.
3. Preserve the interrupted transaction journal and generation evidence. Agent startup calls recovery; independently examine the result because startup alone does not certify successful recovery.
4. Repair the diagnosed cause under maintenance control; restart only affected services. Use actual `status`, `reconcile [--force]`, or `rollback` only when their prerequisites are met. Reindex is separate derived-cache recovery and cannot restore the identity DB.

### Verification Oracle

- Authorized API-to-agent calls succeed over the real kernel-checked socket; unauthorized UID/credential combinations fail without host effects.
- Independent probes confirm consistent active generation/services and no unfinished unsafe transaction. Agent loss always denies mutation rather than using an in-process privileged fallback.

## Runbook 10: Certificate expiry and mail queue recovery

**Runbook ID**: `certificate-expiry-and-mail-queue-recovery`

Targets: A39, A42-A44; F05.

### Preconditions

- Identify actual configured certificate issuance/renewal client, service certificate paths, mail daemons, queue, and external observer. Catalog metadata is not evidence these services are installed or wired.
- Preserve existing valid certificate/key and mail queue data; use synthetic messages for recovery drills.

### Execution Steps

1. Inspect certificate expiry, hostname/SAN/trust, renewal service logs, HTTP-01 routing or DNS-01 authority/propagation, CAA, clock, and rate limits. Diagnose with the installed client; no general `xpanel-ctl certs` command exists.
2. Renew through the configured qualified ACME integration, test candidate syntax/key matching before activation, and keep the previous certificate active if issuance fails. Verify external handshake/chain and renewal scheduling.
3. Inspect actual mail services and queue with native read-only diagnostics where installed:

   ```bash
   systemctl is-active postfix.service dovecot.service
   postqueue -p
   postfix check
   dovecot -n
   ```

4. Resolve DNS/network/authentication/quota/recipient causes before any approved retry/queue mutation. Deletion needs exact validated queue IDs and explicit review; do not mass-delete or fabricate a panel queue operation. Validate actual Rspamd/LMTP/outbound policy only where configured.

### Verification Oracle

- External clients see the intended unexpired trusted certificate; failed renewal preserves prior working service and produces actionable retry/alert evidence.
- Separate SMTP accepted/delivered/deferred/bounced outcomes; verify delivery with real SMTP/IMAP and external mailboxes, not JSON or queue acceptance alone. No open relay, tenant leak, or unintended message loss.
- Absent live adapters keep A39/A42-A44 pending; metadata or native-command availability alone does not qualify the feature.

## Release Governance & Honest Verification Status Policy

The four legacy labels remain for compatibility with the declarative [scenario mapping](../planning/acceptance-scenario-mapping.json):

| Label | Intended evidence class | What this mapping establishes |
|---|---|---|
| `primitive_verified` | Unit rules/renderers/invariants (U) | No independent acceptance or execution receipt |
| `portable_verified` | Portable control-plane/HTTP/browser contracts (U/H/B) | No guarantee mapped harnesses exist or ran |
| `pending_live_service_proof` | Required VM/external-service evidence (V/E) remains pending | No assertion preceding portable evidence is complete |
| `pending_pilot` | A60 requires the 30-60 day pilot and review | No pilot completion |

> **Evidence warning:** `portablePrimitiveVerified` and `verificationStatus` are legacy schema fields. The mapping explicitly states `evidenceAssessment: declarative_unaccepted` and `independentAcceptance: false`. Structural consistency, string length, listed filenames, and matching arrays do not prove executable harness presence, execution, service wiring, recovery, or accepted completion.

Maintain separate reviewed receipts using `not_run`, `running`, `passed`, `failed`, `blocked`, or `not_applicable`, bound to source/artifact/definition hashes, environment, expected and actual observations, and independent oracles. A missing prerequisite is blocked, never a passing skip. No V/E scenario closes from portable-only results; no pilot closes from elapsed time alone. The project remains prelaunch until all applicable release gates pass with current evidence and explicit support limits. Preserve failed runs and never derive production readiness from test counts.
