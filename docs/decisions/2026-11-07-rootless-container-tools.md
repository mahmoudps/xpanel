# Rootless container tools

Decision for the nine WHM container tools (images, registries, networks, volumes, engine settings, compose stacks, container apps, overview, container detail), 2026-11-07.

## Where containers run

The panel creates no root container and adds no daemon. Every new workload runs rootless under one account chosen by root, in that account's slice, with its plan limits and its own image, network and volume store. The existing `/run/xpanel-ctr/<user>` runtime directory and `xpanel-ctr-<user>-<name>.service` units carry it.

Host engines stay as they were: observed, with start, stop and restart jobs. A Docker engine an operator installed by hand is never written to.

Podman stays optional. Until an operator installs it from the software center, every read says `not-installed` and every write refuses with that reason. `newuidmap` and subordinate ids get their own reasons.

## Desired state

- A stack is one record in the account's runtime registry file: the compose text, env text, notes and operator overrides. Services are derived from the text on every read, so no second copy can drift.
- Reconciliation compiles each service to one unit. Suspension, plan changes, rollback and termination follow the paths account containers already use.
- The host-wide trust policy and templates are one root-only file, `extended/containers/policy.json`. Pull mirrors render to `/etc/containers/registries.conf.d/90-xpanel.conf`, which reaches every rootless store without a restart.

## Compose

There is no compose binary. A subset is parsed and validated before anything is created. A key that is not honoured is refused by name, so privileged mode, host networking, devices, capabilities, build and host paths cannot be expressed.

All services of a stack join the first service's network namespace, as a pod does, and resolve each other's names to 127.0.0.1. This needs no bridge network or DNS plugin, and it works on the oldest Podman the supported systems ship. Published ports belong to that first service. Restart propagates to the joined services through `BindsTo=`.

## Isolation

- Every Podman command is a reviewed argv under the account's uid, gid and slice; the executor rebuilds and compares it, so no other unit, user, path or subcommand passes.
- Ports bind to 127.0.0.1 by default. A guard refuses connections to a published loopback port from any other hosting account, while Nginx and system users keep access for the reverse proxy. It is a separate nftables table with its own oneshot unit, so it holds with zero firewall rules, survives a reload of the operator's ruleset and leaves with the last published port.
- Binding to 0.0.0.0 is the operator's explicit choice, and the firewall still decides whether the port is open.
- Bind mounts stay under `~/containers/<stack>`, so quotas and account backups cover them. Named volumes live in the account store inside the home.
- A registry login runs `podman login` as the account. The password reaches it through a root-only file that systemd opens, and the credentials land in the account's own auth file. They are never shared between accounts and never reach argv, audit or a view. A stack's env values stay in the root-only registry; views carry the names only.
- Inspect never reads a container's environment.

- Builds pass `--pull=never`: a base image reaches the store only through a pull the trust policy admitted. The build itself runs as the account.
- Archives and build folders are paths inside the account home, and the command runs as the account, so they cannot name another account's files.
- A container terminal uses the approved terminal design: password re-authentication, a single-use ticket, idle and absolute limits, one session per user, audited start and stop. It runs `podman exec` as the account; root inside the container is the account outside it. The agent re-reads the container in that account's store before opening, and suspending the account ends the session.
- Live logs are bounded to four viewers and ten minutes each, and output stops being read when the viewer lags.

## App catalog

Apps ship with the panel. A feed overlays them when its envelope verifies against the release signing keys, under its own signing domain, with the same sequence floor as the application catalog. An expired or rolled-back feed is refused, and if a stored feed lapses the shipped apps remain and the page says so. The feed URL must be https on a public host name, redirects are refused, and the body is stored only after verification.

## Refusals

`IN_USE` (image, volume, network), `PORT_IN_USE`, `AUTH_FAILED`, `subnet_overlap`, `untrusted_registry`, `invalid_compose` and the engine reasons arrive in the refusal's `reason` field; the HTTP status keeps the product's error codes.

## Not applicable, and why

Daemon start, stop and restart do not apply. Podman has no daemon: each container is a child of its own systemd unit, so there is nothing to start or restart, and a restart would have no acceptance to meet. The cPanel-style equivalents are the stack's Start, Stop and Restart, and the mirror needs no restart because `registries.conf.d` is read on each pull. Repair runs `podman system migrate` per account. The IPv6 toggle is a per-network choice on network creation.

App backup and restore are not separate actions: an app's data sits in the account home, so account backups carry it.
