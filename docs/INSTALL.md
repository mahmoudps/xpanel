# Installing xPanel

This guide describes the installer contract of this source revision: `scripts/install.sh`, `scripts/install-bootstrap.mjs`, `scripts/management-tls.mjs` and `bin/xpanel-ctl`.

> **No public release exists yet.** Installation needs a signed release archive and its trust material from the release publisher. This repository does not publish a download location, and the installer does not download xPanel, Node.js or pnpm. xPanel is prelaunch: install it only on a fresh server dedicated to it. See [status](STATUS.md).

## 1. Check the host

| Requirement | Detail |
|---|---|
| Operating system | Ubuntu 22.04 LTS, Ubuntu 24.04 LTS, AlmaLinux 9, Rocky Linux 9 or CentOS Stream 9. These are the five qualification profiles. The installer also accepts Enterprise Linux 10 package plans, which are not a qualification profile. |
| Server | A fresh server dedicated to xPanel, with root access and a running systemd. |
| cgroups | The cgroup v2 unified hierarchy with the `cpu`, `memory`, `io` and `pids` controllers. The installer refuses without them. |
| Size | The control plane targets 1 vCPU and 1 GB of memory. This is an acceptance budget, not a measured guarantee; hosted services and accounts need more. See [standards](STANDARDS.md#resource-targets). |
| `/home` | ext4, where the installer enables journaled user quota, or XFS mounted with `uquota` at boot. Account creation refuses until user quota is enforced. |
| Kernel | The installer makes sure every bootable kernel carries the quota format modules (on Ubuntu it adds `linux-modules-extra` when needed). |
| SELinux | On Enterprise Linux, SELinux stays enforcing; the installer sets the ports, booleans and file contexts xPanel needs. |
| Existing services | The xPanel API and agent must not be running. Existing DNS configuration and zones are preserved, and the installer refuses to take them over without a reviewed migration. An existing MariaDB data directory is kept; it must be running with local root socket access. |

The live installer provisions Apache with `mpm-itk` behind nginx. It refuses other web engine or MPM choices, so no account ever shares an identity.

### Package sources

| Profile | Repositories the installer enables |
|---|---|
| Ubuntu | `universe` and the `ppa:ondrej/php` PHP archive |
| Enterprise Linux | CRB, EPEL and Remi. Packages the repositories lack, such as `mpm-itk`, are built from pinned upstream sources. |

The installer always installs the web stack (nginx, Apache, PHP-FPM), PostgreSQL, Redis, certbot, nftables, quota tools, the Web Disk and calendar servers, the statistics engines and a C compiler for the native helpers. The `--with-*` options add the optional services listed in [step 5](#5-install).

## 2. Plan DNS and the firewall

Choose one management host name, for example `panel.example.com`. Before installing, point these three names at the server's management address:

| Name | Product | URL |
|---|---|---|
| `panel.example.com` | xPanel | `https://panel.example.com:2083` |
| `whm.panel.example.com` | xWHM | `https://whm.panel.example.com:2087` |
| `mail.panel.example.com` | xMail | `https://mail.panel.example.com:2096` |

The three products need three distinct host names because browsers share cookies across the ports of one host. Keeping them under one registrable domain lets the one-time handoffs between products carry their `SameSite=Strict` cookies.

Make these ports reachable from the internet:

| Port | Use |
|---|---|
| `80` | ACME HTTP-01 challenges for the management certificate, and hosted sites |
| `443` | Hosted sites |
| `2083`, `2087`, `2096` | xPanel, xWHM and xMail |
| `22` | SSH |
| `2078`, `2080` | Web Disk, and calendars and contacts |
| `25`, `465`, `587`, `110`, `995`, `143`, `993` | Mail, when installed with `--with-mail` |
| `53` (TCP and UDP) | Authoritative DNS, when installed with `--with-dns` |
| `21` and the passive range | FTP, when installed with `--with-ftp` |

The private API listeners `12083`, `12087` and `12096` bind to loopback only; nginx terminates TLS in front of them.

## 3. Prepare the release inputs

The installer works only from authenticated inputs. Keep every input on durable root-owned storage: paths under `/tmp`, `/var/tmp` or `/home` are refused.

| Input | Description |
|---|---|
| Release archive | `xpanel-release-X.Y.Z.tar.gz` |
| Publisher manifest | `xpanel-release-X.Y.Z.manifest.json`, beside the archive. It carries the Ed25519 signature over the version, schema version, archive SHA-256 and unpacked size. |
| Archive SHA-256 | Obtained from the publisher through a separate channel |
| Archive authentication key | The key that authenticates the archive inventory. Root-owned, mode `0600`, at least 32 bytes. |
| pnpm | A pnpm 12.15.0 executable, root-owned and not writable by group or others |
| Release trust file | Root-owned JSON, mode `0600` |
| Publisher keys file | Root-owned JSON with the trusted Ed25519 public keys |
| Node.js | Node.js 26.12.1, root-owned and not writable by group or others. The installer uses `/usr/bin/node`, or the path in `XPANEL_NODE_BIN`. |

The release trust file names the archive key and the package manager:

```json
{
  "keyId": "<archive key id>",
  "signingKeyPath": "/root/xpanel-trust/archive.key",
  "packageManagerPath": "/opt/pnpm-12.15.0/pnpm",
  "packageManagerSha256": "<sha256 of the pnpm executable>"
}
```

The publisher keys file lists between 1 and 8 Ed25519 public keys:

```json
{
  "schemaVersion": 1,
  "keys": [
    { "keyId": "<publisher key id>", "algorithm": "ed25519", "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n" }
  ]
}
```

The installer keeps copies of the trust in `/etc/xpanel` (`release-trust.json`, `release-hmac.key` and `release-keys.json`). Later releases are authenticated with those copies and installed with the pnpm executable at the recorded path, so keep it there.

The installer installs production dependencies offline from root's pnpm store, with `--frozen-lockfile` and store integrity checks. Fill that store first from an extracted copy of the verified release, with the pinned runtimes on `PATH`:

```sh
sha256sum -c <<< "<archive sha256>  /root/xpanel-release/xpanel-release-X.Y.Z.tar.gz"
install -d -m 0755 /root/xpanel-src
tar -xzf /root/xpanel-release/xpanel-release-X.Y.Z.tar.gz -C /root/xpanel-src
cd /root/xpanel-src && /opt/pnpm-12.15.0/pnpm fetch --prod
```

Run the installer from this extracted copy. It verifies the archive again before it changes the host.

## 4. Inspect the plan

A dry run renders the package list, directory layout, service units and management TLS plan without changing the host. It also validates the release trust inputs:

```sh
XPANEL_NODE_BIN=/opt/node-v26.12.1/bin/node bash scripts/install.sh --dry-run --new-install \
  --artifact=/root/xpanel-release/xpanel-release-X.Y.Z.tar.gz \
  --artifact-sha256=<archive sha256> \
  --release-trust-file=/root/xpanel-trust/release-trust.json \
  --release-keys-file=/root/xpanel-trust/release-keys.json \
  --with-mail --with-dns --dns-address=<management address> --with-ftp --with-mariadb \
  --management-hostname=panel.example.com --management-address=<management address> \
  --acme-email=hostmaster@example.com --accept-acme-terms
```

Review the output before continuing. A dry run does not certify package availability, services or host permissions.

## 5. Install

Run the same command as root without `--dry-run`. Consider running it in a transient unit, for example with `systemd-run --wait --collect`, so a dropped SSH session cannot interrupt it.

| Option | Effect |
|---|---|
| `--new-install` | Required for live provisioning: an authenticated, versioned release under `/opt/xpanel/releases/<version>` with the `/opt/xpanel/current` link |
| `--artifact`, `--artifact-sha256`, `--release-trust-file`, `--release-keys-file` | The authenticated release inputs from [step 3](#3-prepare-the-release-inputs) |
| `--php=8.3` | PHP version for the default pool (default `8.3`) |
| `--with-mail` | Postfix, Dovecot with LMTP, Sieve and full-text search, and OpenDKIM |
| `--with-dns --dns-address=IP` | PowerDNS with the BIND backend on an address assigned to this host |
| `--with-ftp` | Pure-FTPd |
| `--with-mariadb` | MariaDB with protected local administrator access |
| `--with-modsecurity` | ModSecurity with the OWASP Core Rule Set |
| `--management-hostname`, `--management-address`, `--acme-email`, `--accept-acme-terms` | The management TLS step: a Let's Encrypt certificate for the three management names and the nginx ingress. Repeat `--management-address` for each address. By passing `--accept-acme-terms` you accept the certificate authority's terms. |

The installer runs in numbered phases and records each one in `/var/lib/xpanel/install-journal.json`. It:

1. prepares the kernel quota modules, then verifies and prepares the release;
2. creates the `xpanel` and `xpanel-agent` service identities and the directory layout, and sets `/home` to `0711`;
3. installs the packages, applies the OS profile, sets SELinux policy on Enterprise Linux, and configures the optional services;
4. installs the jailed shell and builds the native account-file, terminal and peer identity helpers;
5. applies kernel link protection, writes the systemd slice and units, initializes the control database, and installs `xpanel-ctl`, `xuapi` and `xwhmapi`;
6. enforces user disk quota on `/home`, issues the management certificate, configures the ingress and enables the services.

The services are enabled but not started. If the installer reports that quota is pending, finish it after the first start (see [step 6](#6-first-start)).

If the run stops after the release was prepared, resume it with `--resume-prepared` and the same release inputs instead of `--new-install`.

## 6. First start

Run the administrative CLI with the installed runtime. As root it re-runs itself as the `xpanel` service user.

1. Create the root identity, reading one password line from a protected file or standard input:

   ```sh
   /opt/xpanel/bin/node /opt/xpanel/current/apps/api/src/main.ts init-root --password-stdin < /root/xpanel-root.pass
   ```

2. Start the services:

   ```sh
   systemctl start xpanel-agent xpanel-api
   ```

3. Open `https://whm.panel.example.com:2087/login`, sign in as `root` and set a new password. The first sign-in requires the change.
4. Complete the first-run setup (host name, nameservers, contact address and primary address) in xWHM under **Server > Setup & settings**, or with `xwhmapi setup wizard_create`.
5. If quota was reported as pending, enable it. On XFS, add the `uquota` mount option first (`rootflags=uquota` for `/`) and reboot.

   ```sh
   /opt/xpanel/bin/node /opt/xpanel/current/apps/api/src/main.ts init-quotas
   ```

Two-factor sign-in is optional: an account with an enrolled TOTP factor must present it at every sign-in, and an account without one signs in with its password.

## 7. Finalize the installation

Native upgrades need a finalized installation and the lifecycle coordinator. Do this before you create the first account: finalization accepts only an installation without accounts. A populated installation uses `xpanel-ctl adopt` instead.

```sh
xpanel-ctl install --apply --yes \
  --artifact /root/xpanel-release/xpanel-release-X.Y.Z.tar.gz --sha256 <archive sha256> \
  --signing-key /etc/xpanel/release-hmac.key --key-id <archive key id>

cd /opt/xpanel/releases/X.Y.Z && /opt/xpanel/bin/node scripts/coordinator-install-entry.mjs \
  --artifact=/root/xpanel-release/xpanel-release-X.Y.Z.tar.gz --archive-sha256=<archive sha256>
```

`xpanel-ctl install --apply` reports `installationActive: true` on success. The second command registers `xpanel-lifecycle.service`. `xpanel-ctl doctor` then reports the installed version and the observed prerequisites.

## 8. Verify

- `systemctl is-active xpanel-agent xpanel-api xpanel-lifecycle` shows three active units.
- The three management URLs serve a trusted certificate and their own sign-in page.
- `/opt/xpanel/bin/node /opt/xpanel/current/apps/api/src/main.ts status` shows the panel, server and generation status.
- `/opt/xpanel/bin/node /opt/xpanel/current/scripts/management-tls.mjs verify`, run as root, observes the management ingress.

Installation does not qualify the host. Native qualification of a release is a separate, evidence-producing process; see [qualification](decisions/qualification.md).

## Files and locations

| Path | Contents |
|---|---|
| `/opt/xpanel/releases/<version>`, `/opt/xpanel/current` | Installed releases and the active release link |
| `/opt/xpanel/bin` | `xpanel-ctl`, `xuapi`, `xwhmapi`, the native helpers and the runtime link `node` |
| `/etc/xpanel` | Runtime and API environment, protected credentials, release trust, management TLS configuration |
| `/var/lib/xpanel/state` | Desired hosting state: accounts, domains, plans, resellers and server settings |
| `/var/lib/xpanel/control.db` | SQLite control database: identity, sessions, MFA, tokens, jobs, audit and the derived index |
| `/var/lib/xpanel/generations` | Configuration generations used for rollback |
| `/var/lib/xpanel-lifecycle` | Installation receipt, lifecycle journal and upgrade snapshots |
| `/var/log/xpanel` and the systemd journal | Logs |

Next: [operations](OPERATIONS.md).
