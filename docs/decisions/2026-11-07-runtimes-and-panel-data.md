# Runtimes, developer tools and panel data (2026-11-07)

Scope: Go and Java projects, Python versions and named environments, Composer runs, PEAR for account owners, the API shell and explorer, the metrics endpoint, error reporting, configuration as code, panel data backups, the integrations hub and plugin import.

## Go and Java projects

A project is one more application of the account: one saved entry in its runtime file, one service in its slice, one front socket. Decision 8 applies. Go and Java programs listen on TCP, and neither has a dependable way to listen on a unix socket, so these two runtimes get a TCP port where Node, Python and Ruby do not.

The port is private. It comes from 20000 to 29999, is unique on the host, and the unit may bind only that port (`SocketBindAllow=tcp:<port>` before `SocketBindDeny=any`). The firewall output chain keeps it to its owner: another account can neither connect to the port over loopback nor answer on it while the application is down, so a stopped project cannot be impersonated. Nginx still reaches the application through the root-owned front socket and `systemd-socket-proxyd`, which now connects to `127.0.0.1:<port>`.

A project runs a built file. Deploying from source is not offered, as on aaPanel, so the Go toolchain is reported but not required. Java uses the selected JDK, found under `/usr/lib/jvm`; a JDK that is not installed refuses with `RUNTIME_MISSING`. An executable without an execute bit refuses with `NOT_EXECUTABLE`. Only root saves a project, and only root may open its port in the firewall, which also makes the application bind every address.

## Python

Interpreters are distribution packages listed in the software centre, so a release gets only what its repositories carry. A named environment belongs to one account, under `~/python-envs/<name>`, and is created by `python -m venv` as the account. A Python application can name one instead of its own `.venv`.

## Composer

The earlier design waited for a native helper with an offline, digest-pinned artifact graph. Nothing can supply such a graph for an arbitrary project, so the provider port and its qualification evidence are gone. Composer now runs as the account in its sandbox, the same trust as the account's own shell and its Web Apps build step. Project scripts and plugins stay off. The job is a normal host job, so its log is the live output. A mirror is written to the account's global Composer configuration, and a run without a mirror clears it. The target is the document root of a saved site; other folders are not offered.

## PEAR for owners

The owner path now runs PHP's own `pear` as the account, with every directory in `~/php` and `~/.pear`. The inventory is read from pear's registry files in the home, so it shows what the installer did. Keyword search uses the PEAR channel. The full channel listing is not offered, because search by keyword covers it without a large download.

## API shell and explorer

The shell calls any function of the CLI catalog through the normal dispatcher with the caller's own session, so a route repeats its own authentication, permissions, CSRF check and validation. An invalid body is refused identically because it is the same handler. Result shaping runs on the JSON the route returned. The token field sends the call straight from the browser with that token. The OpenAPI 3.1 document is generated from the catalog; request bodies are published as plain objects because the validators are hand-written, not schema-driven. Calls that change a session or re-enter the shell are not listed.

## Metrics, error reporting and webhooks

The scrape reads the latest saved samples, with a 60 second cache for service state. It needs a root API token with `metrics:read`. HTTP request counts per account are not in the saved samples, so they are not exported.

Error reports use the same HTTPS path as webhooks: public addresses only, pinned to the checked address, no redirects. One scrubber runs before anything leaves. A JSON body is kept only while a DSN is saved and only up to 64 KiB. Browser errors are not collected: `web` here means a server-side render failure.

Webhooks follow the audit log, which both the API and the agent write. A cursor and a pending file survive a restart, and the first pass sets the cursor so an endpoint receives nothing from before it existed. The payload carries the event, the time and the target only. Only the six events the page offers are delivered.

## Configuration as code

Files are YAML, one per object, without secrets. An import overlays what it names. Nothing is deleted, because a partial export must stay safe to import. A new account or reseller cannot come from a file, since its password does not travel; for an existing account only the package can change. The preview reports the diff and whether the import is applicable; validators and configuration tests run at apply, and a failed reconcile restores the objects that changed.

## Panel data backups

A snapshot is the existing control snapshot. A restore copies the state tree file by file under the state writer lease, then reconciles. Without overwrite an existing file stays and is reported as skipped. The writer lock and lease authority are never restored. `control.db` stays in the archive and is not swapped under a running API: principals and the audit log live there, so a restore keeps the sign-ins and the audit trail of the running server.

## Plugin import

A third-party plugin uses the plugin package format from the extensibility work, so nothing in it runs. The Software Center card is one more way into the same install route.

## What only a real host proves

The nftables guard against real sockets, `SocketBindAllow` on systemd 249, `systemd-socket-proxyd` to loopback under SELinux enforcing, the JDK paths on each profile, `pear` and `composer` inside the jailed unit, and a restore on a live state tree.
