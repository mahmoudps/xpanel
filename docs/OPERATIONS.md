# Operating xPanel

This guide covers day-to-day operation of an installed server: services, command-line tools, upgrades, rollback, recovery, backups and TLS. It describes the contracts of this source revision. The detailed procedures with preconditions and verification steps are in the [operational runbooks](operations/runbooks.md). Installation is in [INSTALL.md](INSTALL.md).

Run every command below as root. `/opt/xpanel/bin/node` is the pinned Node.js runtime the installer linked; the lifecycle tools refuse any other runtime and refuse to run with `NODE_OPTIONS` or `NODE_PATH` set.

## Services

| Unit | Runs as | Role |
|---|---|---|
| `xpanel-api.service` | `xpanel` | The three panel listeners on loopback, behind nginx |
| `xpanel-agent.service` | root | Reconciler and host operations, on `/run/xpanel/agent.sock` |
| `xpanel-lifecycle.service` | root | Lifecycle coordinator: runs native upgrades and recovery |
| `xpanel-management-tls.timer` | root | Renews the management certificate |
| `xpanel.slice` | | Parent cgroup slice of the per-account slices |

```sh
systemctl status xpanel-agent xpanel-api xpanel-lifecycle --no-pager
journalctl -u xpanel-agent -n 100 --no-pager
```

## Command-line tools

| Tool | Purpose |
|---|---|
| `/opt/xpanel/bin/node /opt/xpanel/current/apps/api/src/main.ts <command>` | Administrative CLI. As root it re-runs itself as the `xpanel` user. |
| `xpanel-ctl` | Lifecycle state, diagnostics, release verification and installation finalization |
| `xuapi`, `xwhmapi` | The account and server APIs over a local socket, with the same authorization and audit as the web. See [the CLI API guide](../apps/api/src/cli-api/README.md). |
| `/opt/xpanel/bin/node /opt/xpanel/current/scripts/management-tls.mjs <phase>` | Management certificate and ingress |

Administrative CLI commands:

| Command | Effect |
|---|---|
| `status` | Panel, server and generation status |
| `reconcile [--force]` | Compile desired state and reconcile the host (needs the agent) |
| `reconcile --resolve-failed <id>` | Verify the disk, clear a generation whose rollback failed, then reconcile |
| `rollback <generation-id>` | Restore and reconcile an earlier configuration generation (needs the agent) |
| `reindex` | Rebuild the derived SQLite index from the state files |
| `init-root --password-stdin` | Create the root identity once; the first sign-in must change the password |
| `reset-password <username> --password-stdin` | Set a new password, clear lockouts and remove security questions |
| `disable-2fa <username> --confirm` | Remove an enrolled factor; revokes the user's sessions and API tokens |
| `panel-access show`, `panel-access reset <part>` | Show or clear allowlists, the entrance, the response, basic auth, stopped entry points or temporary links |
| `init-quotas [--path <dir>]` | Enable enforced user quota on the filesystem of account homes |
| `recover-provisioning <job-id> --attest-host-recovered` | Requeue an account whose host step was interrupted |
| `repair-state-ownership` | Give the `xpanel` user the state tree |

`xpanel-ctl` commands plan by default. A change acts only with `--apply --yes` and the required authenticated inputs, and every result is a stable code:

| Command | Effect |
|---|---|
| `xpanel-ctl status` | Whether a lifecycle operation holds attention |
| `xpanel-ctl doctor` | The installed version and observed native prerequisites |
| `xpanel-ctl update --check --artifact FILE --sha256 HEX --signing-key FILE --key-id ID` | Authenticate a release archive without changing anything |
| `xpanel-ctl verify-install-source ... --artifact-dir DIR` | Compare an archive with an extracted tree |
| `xpanel-ctl install --apply --yes ...` | Finalize a prepared installation that has no accounts |
| `xpanel-ctl adopt --apply --yes ...` | Finalize a populated prepared installation through the signed repair helper |

The native `update`, `upgrade` and `recover` effects run only inside the lifecycle coordinator; started from a shell they refuse with `LIFECYCLE_COORDINATOR_SOURCE_REQUIRED`. `rollback-release` and `uninstall` are plan-only at this revision. There is no purge or OS-upgrade command.

## Upgrades

An upgrade installs the new release beside the running one and switches over only after its checks pass. The release must be signed by a key in `/etc/xpanel/release-keys.json` and authenticated with the archive key in `/etc/xpanel/release-hmac.key`.

The upgrade machine:

1. runs the preflight: free space, supported OS, a newer version, a compatible schema, and no active transfer or package job;
2. drains writers under the lifecycle admission lock and snapshots the state files, index and units;
3. applies expand-only migrations;
4. switches `/opt/xpanel/current` to the new release, reconciles, and restarts the panel;
5. passes the health gate, or rewinds the release link, state files, index and units from the snapshot and runs the health checks again.

### Steps

1. **Prepare.** Place the archive and its `.manifest.json` beside each other on durable root-owned storage. Fill root's pnpm store for the new release, as at installation (`pnpm fetch --prod` in an extracted copy). Copy `/var/lib/xpanel-lifecycle`, `/var/lib/xpanel` and `/etc/xpanel` off the host.
2. **Stage** the release with the active release's acquisition entry. It authenticates the archive, installs the production dependencies offline and prepares `/opt/xpanel/releases/X.Y.Z`:

   ```sh
   CURRENT=$(readlink /opt/xpanel/current)
   /opt/xpanel/bin/node "$CURRENT/scripts/acquire-lifecycle-release.mjs" \
     --artifact=/root/xpanel-release/xpanel-release-X.Y.Z.tar.gz --sha256=<archive sha256>
   ```

3. **Rotate** the lifecycle coordinator to the staged release:

   ```sh
   cd /opt/xpanel/releases/X.Y.Z && /opt/xpanel/bin/node scripts/coordinator-rotate-entry.mjs \
     --artifact=/root/xpanel-release/xpanel-release-X.Y.Z.tar.gz --archive-sha256=<archive sha256> \
     --operation-id=$(cat /proc/sys/kernel/random/uuid) --mode=apply
   ```

4. **Upgrade**, from xWHM or from the shell:
   - In xWHM, **Server > Upgrade** shows the staged release, runs the preflight and starts the upgrade after you type `upgrade X.Y.Z`. The same functions are `xwhmapi server upgrade_preflight` and `xwhmapi server upgrade_start`.
   - From the shell, run the operator entry of the staged release. It prints one JSON result and exits `0` when the upgrade succeeded:

     ```sh
     cd /opt/xpanel/releases/X.Y.Z && /opt/xpanel/bin/node scripts/root-operator-entry.mjs \
       --kind=upgrade --archive-sha256=<archive sha256> --operation-id=$(cat /proc/sys/kernel/random/uuid)
     ```

Run steps 2 to 4 one at a time, each with a fresh operation ID, and never replay an operation. A transient unit (`systemd-run --wait --collect ...`) keeps a step running if the SSH session drops.

After the upgrade settles, the agent installs any OS packages the new release declares in one host job, `system.packages.release:<version>`. The upgrade page reports it per feature; `xwhmapi server upgrade_packages_retry` retries a failed job. The scheduled updater in **Server > Upgrade** takes a release only from verified staged releases and runs the same preflight and checks as an operator.

## Rollback and recovery

| Situation | Action |
|---|---|
| The upgrade failed its checks | The machine rewinds to the previous release automatically and reports `rolled_back`. |
| An upgrade or recovery was interrupted | `xpanel-ctl status` reports the retained attention. Run the operator entry with `--kind=recover`, from the release the coordinator runs and with that release's archive SHA-256. Do not delete lifecycle barrier files by hand. |
| A committed release must be withdrawn | `xpanel-ctl rollback-release --release X.Y.Z` plans only; native release rollback is not available at this revision. Use the off-host copy and a reviewed recovery procedure. |
| A configuration change broke a service | `rollback <generation-id>` restores an earlier configuration generation through the agent. |
| `reconcile` answers HTTP 412 with phase `needs_attention` | `reconcile --resolve-failed <id>` checks that the owned files match the journal backup or the failed candidate, records an audit row and clears the journal. Then run `reconcile`. |

Configuration generations and releases are separate: a generation rollback never changes the installed release, and a release rewind restores its own snapshot.

## Release retention

Installed releases live side by side under `/opt/xpanel/releases`. After an upgrade settles successfully, the lifecycle prunes
releases nothing needs any more. It never prunes after a failed or rolled-back upgrade. A release stays when a verified record or
live reference names it: the current release, the rollback target, an open transition, the coordinator helper, a newer or
unfinished prepared release, a unit file or a running process. Stale prepared records and staging leftovers go with the release.

```sh
xpanel-ctl releases prune --dry-run   # what would be removed, and why each kept release stays
xpanel-ctl releases prune             # remove them (root, under the lifecycle writer lock)
```

The prune fails closed: if any record disagrees or cannot be read, nothing is removed and a stable `RELEASE_RETENTION_*` code
names the reason. It moves each checked target into a quarantine directory on the same filesystem before deleting it, under a
durable record, so an interrupted prune resumes cleanly.

## Backups

### Scheduled backups in the product

The backup tools are implemented in source and, like every tool, open after native qualification ([status](STATUS.md)):

- **xWHM > Backups & transfers:** schedules, account selection and compression; destinations; account and file restore.
- **xPanel > Files > Backup:** the account owner's own backups and file restoration.

Each scheduled run writes one archive per account and a control-state snapshot (`xpanel-control-<timestamp>.tar.gz` or `.tar.zst`) holding a copy of the control database, under `/var/lib/xpanel/backups`. An archive is verified by a full read-back (gzip CRC or the zstd frame checksum) before it is uploaded. Destinations are a separate local disk, S3-compatible storage (including Backblaze) and SFTP with pinned host keys. Backup work runs at low CPU and I/O priority.

### Control-plane recovery set

The control plane is recovered as one consistent set:

- `/var/lib/xpanel/control.db` with its `-wal` and `-shm` files: identity, sessions, MFA, tokens, jobs and audit;
- `/var/lib/xpanel/state` and `/var/lib/xpanel/generations`: desired state and configuration generations;
- `/etc/xpanel`: environments, protected credentials (`agent.token`, `server.secret`, `ingress.secret`), release trust and management TLS configuration;
- `/var/lib/xpanel-lifecycle`: installation receipt and lifecycle journal.

Never copy a live `control.db` alone. Stop `xpanel-api` and `xpanel-agent`, or use the scheduled control snapshot. `server.secret` seals stored authentication material: a database restored without its matching secret cannot unseal it. Keep the set off the host and protected; it holds credentials.

`reindex` rebuilds only the derived index from the state files. It cannot restore identities, passwords, factors or audit.

## TLS

### Management certificate

The installer issues one Let's Encrypt certificate for the three management names through HTTP-01 on port `80`, and writes the nginx ingress for ports `2083`, `2087` and `2096`.

| Path | Contents |
|---|---|
| `/etc/xpanel/management-tls.json` | Host name, addresses and ACME contact |
| `/etc/xpanel/management-acme` | ACME account and certificate store |
| `/var/lib/xpanel-management-tls` | Lifecycle state, challenge webroot and logs |
| `/etc/nginx/conf.d/xpanel-management.conf` | The managed ingress |

```sh
/opt/xpanel/bin/node /opt/xpanel/current/scripts/management-tls.mjs verify
/opt/xpanel/bin/node /opt/xpanel/current/scripts/management-tls.mjs renew
/opt/xpanel/bin/node /opt/xpanel/current/scripts/management-tls.mjs reset-access
```

`xpanel-management-tls.timer` runs the renewal. `verify` observes the ingress without changes. `reset-access` returns the default ports and host names after a panel-access change locked you out; it restarts the panel and rolls back on failure. `active-command.json` and `active-transition.json` in the state directory mark an unresolved transition: inspect them, do not delete them. The [ingress guide](../deploy/nginx/README.md) has the full contract.

### Site and service certificates

Certificates for hosted sites, mail and Web Disk are separate from the management certificate. They are managed through the xWHM **Domains, DNS & SSL** tools and the AutoSSL policy.

## Access recovery

- **Forgotten root password:** `reset-password root --password-stdin` sets a new one, clears lockouts and removes security questions.
- **Lost authenticator:** `disable-2fa <username> --confirm` removes the factor and revokes that user's sessions and API tokens.
- **Locked out by panel access rules:** `panel-access show` prints the entrance and rules; `panel-access reset all` clears them and repairs a damaged rules file. It writes the saved files directly, so it works while the API is down.
- **Moved ports or host names:** `management-tls.mjs reset-access`, above.

Each of these is a sensitive, audited local operation. Record why it was run.

## Diagnostics

- Disk full: check `df -h` and `df -i` for `/`, `/var/lib/xpanel` and `/home` before cleaning anything; keep current and rollback generations, the database with its WAL, backups and audit.
- Agent unreachable: compare the unit status, the journal and `stat -c '%a %U:%G %n' /run/xpanel /run/xpanel/agent.sock`. Never widen the socket permissions.
- Every step-by-step procedure is in the [operational runbooks](operations/runbooks.md).
