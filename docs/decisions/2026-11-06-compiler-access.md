# Compiler Access and Directory Privacy (2026-11-06)

Owner decision 2026-11-06: both tools behave like cPanel ("Compiler Access" in WHM, "Directory Privacy" in cPanel),
adapted to desired state in files, the agent applying it, and the nginx edge in front of Apache.

## Compiler Access

**Purpose.** A local exploit or a malicious binary is usually built on the target host. Restricting the C/C++
toolchain to root and an explicit group is a speed bump against that, not a sandbox: an account can still upload a
binary built elsewhere. cPanel restricts `/usr/bin/gcc` to `0750 root:compiler`; enabling gives every user access again.

**What is restricted.** The compilers, assemblers and linkers: `gcc`, `cc`, `c++`, `g++`, `as`, `ld`, `ld.bfd`,
`ld.gold`, their `-<N>` versioned names and the `<triplet>-linux-gnu-*` (Debian) and `<triplet>-redhat-linux-*` (EL)
variants that are installed. Ownership becomes `root:xpanel-compilers`, mode `0750`. The script changes **regular
files only**: `chmod` follows symlinks, so a symlink such as `/usr/bin/cc -> /etc/alternatives/cc` is never followed to
an unexpected target, and every alias resolves to one of the restricted real files. On the Ubuntu 22.04 guest the
matched files were `x86_64-linux-gnu-gcc-11`, `x86_64-linux-gnu-as`, `x86_64-linux-gnu-ld.bfd` and
`x86_64-linux-gnu-ld.gold`. `make` is not a compiler and is left alone; the dynamic loader can never match.

**State and modes.** `extended/server/compiler-access.json` holds `{ restricted, accountIds }`. `restricted: true` is
cPanel's "Disable Compilers" plus "Allow specific users"; `restricted: false` is "Enable Compilers" and gives back
`0755 root:root` only to files that still carry the `xpanel-compilers` group. No file means the distribution's
permissions are never touched. The group is a system group (`groupadd -r`). Membership is declarative: every
reconcile sets the exact member list with `gpasswd -M`, so a deleted account leaves the group (cPanel's list does not
follow account deletions). Accounts on a jailed shell stay restricted (owner rule); they are reported as excluded.

**Re-apply after package updates.** The same idempotent script (`/usr/local/sbin/xpanel-compiler-access`) runs from
every reconcile and from the package manager:

| Family | Mechanism | Why |
|---|---|---|
| Ubuntu 22.04/24.04 | `/etc/dpkg/dpkg.cfg.d/xpanel-compiler-access` with `post-invoke` | Built into dpkg; runs after every dpkg run, including apt, unattended-upgrades and a direct `dpkg -i`. No package to install. |
| EL 9/10 | `/etc/dnf/plugins/post-transaction-actions.d/xpanel-compiler-access.action` for `gcc*` and `binutils*` | The dnf-plugins-core post-transaction-actions plugin is the reviewed dnf hook; it runs once per transaction that installs or updates those packages. |

On EL the hook needs the plugin package `python3-dnf-plugin-post-transaction-actions`, which the installer now
installs with the bootstrap packages (OS profile and `scripts/install.sh`, checked by the install parity test).
Checked 2026-11-06 against the published repositories, not a running host:

| Release | dnf | Plugin package (BaseOS) | Actions file |
|---|---|---|---|
| EL 9 (Rocky 9 BaseOS) | dnf 4.14, dnf-plugins-core 4.3.0 | `python3-dnf-plugin-post-transaction-actions` 4.3.0 | `/etc/dnf/plugins/post-transaction-actions.d/*.action` |
| EL 10 (Rocky 10 BaseOS; CentOS Stream 10 BaseOS has the same dnf and dnf-plugins-core) | dnf 4.20, dnf-plugins-core 4.7.0 | `python3-dnf-plugin-post-transaction-actions` 4.7.0 | same |

Both releases ship dnf 4; Rocky 10 BaseOS and AppStream carry no `dnf5` or `libdnf5` package, so the dnf 5 actions plugin
(`libdnf5-plugin-actions`, `actions.d/*.actions`, five fields `callback:filter:direction:options:command`) does not
apply. Both plugin versions read the same three-field line `package_filter:transaction_state:command`, match the filter
as a glob on the package NEVRA, and run each distinct command once per transaction, so one action file serves both
releases. The agent installs the action only when the plugin is present: its action directory and its own
configuration file `/etc/dnf/plugins/post-transaction-actions.conf`. The configuration file is the proof, because
removing the plugin leaves the directory behind while our action is in it. Otherwise it reports
`hook.available: false`. A plugin switched off with `enabled=0` in that file is not detected. A direct `rpm -U`
bypasses dnf; the next reconcile re-applies the restriction.

Rejected options: a systemd path unit on `/usr/bin` (every package write and the script's own `chmod` raise inotify
events; a large transaction can hit the unit's trigger limit and leave it failed, so it is not robust); a dnf Python
plugin under `site-packages` (path changes with the Python version); RPM file triggers (need an RPM we do not ship);
a timer (a polling loop on a 1 vCPU / 1 GB host, with an exposure window).

The dpkg hook never fails a package transaction (`--hook` always exits 0); the reconcile run reports failures.

**Cost (Ubuntu 22.04 guest, 6 vCPU).** The check pass that runs after each package transaction takes about 13 ms
when everything is already restricted (one `sh`, one `stat` per matched file). No daemon, no polling.

**Observation.** `GET /api/server/sec/compiler-access` returns the saved policy, the accounts that can be granted, and
the agent's read of the group entry (`getent group`), the effective mode of each command (following symlinks) and the
hook file. `state` is `applied` only when those match; otherwise `drift`.

## Directory Privacy

The folder's own `.htaccess` carries a marked block (`AuthType Basic`, `AuthName`, `AuthUserFile`,
`Require valid-user`) and its users live in `~/.htpasswds/<folder>/passwd`, outside every document root: the account
files are the desired state, as in cPanel, and they travel with account backups. The agent writes them only through
the confined account file runner, with exact preimage checks; unmanaged `.htaccess` lines are kept byte for byte.
A folder with other access rules or an ip-blocker block is refused (same-level `Require` lines combine as
`RequireAny` and could open it), and the ip-blocker refuses a folder with a privacy block.

**Hash.** New passwords are SHA-512-crypt (`$6$`, 5000 rounds, 16-character salt), hashed in the API so plaintext
never reaches the agent. Apache verifies the hash on every request to the folder through the system `crypt(3)`
(libxcrypt on all five profiles). Measured on the guest: SHA-512-crypt verification 2.6 ms; bcrypt cost 5 (the
`htpasswd -B` default) 3 ms, cost 10 51 ms. bcrypt at a strong cost would cost ~50 ms of CPU per protected request on
a 1 vCPU host, and producing bcrypt here needs either a new dependency, embedded Blowfish tables, or spawning
`htpasswd` per password. Existing bcrypt, apr1, SHA-256/512-crypt, `{SHA}` and DES lines are kept as they are.
cPanel's exact scheme was not verified from a public source.

**Edge.** The nginx sites proxy every request to Apache (no `root`/`try_files`), and the shared cache neither stores
nor serves responses to requests that carry `Authorization`. A response that Apache marked cacheable before the folder
was protected can stay in the edge cache until it expires.

**Truthful state.** A save reports `protectionVerified: true` only when Apache answered 401 without credentials on the
folder URL; Apache must have `auth_basic`, `authn_core`, `authn_file` and `authz_user`, which the installer now enables.
