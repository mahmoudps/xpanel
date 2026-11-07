# SELinux contexts of account homes on EL

Date: 2026-11-07. Scope: Enterprise Linux hosts with SELinux enabled. Debian and Ubuntu take none of these paths.

## Problem

The agent runs as `unconfined_service_t`, which has no file transition, so every directory it creates under `/home` inherits `home_root_t`. Apache runs as `httpd_t` and may search that type but not read it. A measured AlmaLinux 9 host in Enforcing mode showed `home_root_t` on `/home/<user>` and `public_html`, `httpd_enable_homedirs` off, no file context rule for homes, and 3705 `httpd_t` read denials on `public_html`.

`restorecon` alone would not fix it. The base policy gives `public_html` the read-only `httpd_user_content_t`, a home outside `public_html` gets `user_home_t`, and addon and subdomain document roots sit at `/home/<user>/<domain>`, outside `public_html`.

## Decision

| Path | Type | Why |
|---|---|---|
| `/home/<user>` | `user_home_dir_t` (base policy) | sshd and Dovecot expect it. `httpd_enable_homedirs` lets `httpd_t` search it. |
| Entries of the home that do not start with a dot, and their trees, except `mail`, `etc`, `ssl`, `backups` | `httpd_sys_rw_content_t` | Everything PHP may open under `open_basedir`: document roots in any accepted place, `tmp` for sessions and uploads, `logs`, files beside the document root such as `wp-config.php`. |
| `~/.htpasswds` | `httpd_sys_content_t` | Apache reads the Directory Privacy password files. PHP has no reason to change them. |
| `~/mail` | `user_home_t` (base policy) | `dovecot_t` manages it through `userdom_manage_user_home_content_*`. Postfix delivers over LMTP and does not open Maildirs. |
| `~/etc`, `~/ssl`, `~/backups`, other dot entries | base policy | No web process needs them. nginx and Apache read certificates from `/etc/xpanel/ssl`, not `~/ssl`. |

The exclusion is one negative lookahead in one rule. Two overlapping rules would depend on the order of `file_contexts.local`, which `semanage` does not promise. A document root can never sit in an excluded directory because `validateDocRoot` refuses `PROTECTED_HOME_DIRS` and dot segments. A test keeps the two lists in step.

## Why `httpd_sys_rw_content_t` and not `httpd_user_rw_content_t`

Read against the CentOS Stream 9 policy source (`apache.if`, `apache.te`, `userdomain.if`):

- Apache under mpm-itk stays in `httpd_t` after it changes UID. PHP-FPM runs in `httpd_t` when its binary is labelled `httpd_exec_t`, and `init_nnp_daemon_domain(httpd_t)` admits that transition under `NoNewPrivileges`. Otherwise it runs unconfined. Both content templates give `httpd_t` manage rights on their `rw_content` type under `httpd_builtin_scripting`, so the two types are equal for these two.
- Reads differ. `httpd_sys_rw_content_t` is an `httpd_content_type`, readable with `httpd_builtin_scripting` alone. `httpd_user_rw_content_t` is an `httpd_user_content_type`, tied to `httpd_enable_homedirs` for reads.
- CGI decides it. suexec wrappers live under `/var/www`, so they run as `httpd_sys_script_t`, which manages `httpd_sys_rw_content_t` and has no rights on `httpd_user_rw_content_t`.
- The file manager helper, Git, tar during a restore, and the terminal run from the agent as `unconfined_service_t`, so neither type limits them. A file they create inherits the type of its directory.
- `httpd_unified` stays off: neither type needs it, and it would widen `httpd_t` to every content type.

## Isolation

Type enforcement never separated accounts here: all accounts share one type under either choice. Isolation stays what it was: one UID per account, 0750 homes, mpm-itk, and FPM units with `ProtectHome=tmpfs` and `BindPaths=<home>`. `httpd_enable_homedirs` grants search and no DAC access. The rule matches every `/home/*`, so an operator's own login under `/home` gets the same type on a relabel, with the same DAC limits.

Every relabel runs as the account through `runuser`. A home is tenant-writable, so a root walk could be steered outside the home through a swapped symlink. `restorecon` uses `-F` because every type above is customizable: without it, a tree that already holds `httpd_user_content_t` would keep it.

## How the policy reaches a host

- Fresh install: `configure_selinux` runs `scripts/selinux-account-homes.sh`.
- Upgrade: the installer does not run, and the reconcile inside an upgrade belongs to the pre-upgrade release. The upgrade restarts the agent from the new release, so the agent applies the same script at startup when its SHA-256 differs from `/etc/xpanel/selinux-account-homes.sha256`, relabels every home, then writes the stamp. This runs in the background after the socket listens, so the first relabel of a large host does not hold the upgrade's health gate. An interrupted run repeats at the next start.
- New account: each generation relabels the account directories and document roots without recursion, after creating them.
- New document root: relabelled recursively once, because it can point at a folder that already holds files. This action stays out of the effects checksum, so it does not cost a second generation.
- Restore and transfer: the home is relabelled recursively after extraction.
- Directory Privacy: `~/.htpasswds` is relabelled before the `.htaccess` block names the password file.

## Known limits

- A file created directly in a home inherits `user_home_dir_t`, and `mv` keeps a label. A file that the file manager creates in `~` and then moves into a document root stays unreadable to Apache until `restorecon -RF` runs on it. Files created inside a document root are correct.
- A hidden file directly in the home, such as `~/.env`, stays unreadable to PHP. `httpd_read_user_content` would allow it, but it also opens `~/etc`, `~/ssl` and `~/backups`.
- `/home` is the only home base: the executor admits no other.

## Open, needs a live EL run

Nothing here ran on EL. The rule set is derived from the policy source and the measured denials. Confirm on a guest in Enforcing mode, and correct the rules from real AVCs:

- `semanage` accepts the lookahead, and `matchpathcon` returns the expected types.
- `restorecon -F` run as the account succeeds, including the change of SELinux user.
- `httpd_builtin_scripting` is on, and PHP-FPM's domain (`ps -eZ`), including inside `ProtectHome=tmpfs`.
- pure-ftpd's domain. The base policy has no rule for its binary, so it should run unconfined. If `ftpd_t`, it needs `ftpd_full_access`.
- Account Redis and memcached sockets in `~/.xpanel-cache`. `redis_t` or `memcached_t` may refuse that directory, and no rule covers it.
- suexec wrappers under `/var/www/xpanel-cgi` may need `httpd_sys_script_exec_t`.
- PHP `mail()` and MariaDB over its socket may need `httpd_can_sendmail` and `httpd_can_network_connect_db`. Neither is about homes, and neither is set.
