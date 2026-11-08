# DNS cluster and database server profiles

Written to the normal standard, but not proven between two real hosts: owner decision 13 defers the second lab host. What
was exercised is listed under each tool. Neither tool activates until its native proof exists, so their write controls stay
closed in both themes.

## DNS cluster

- **Transport.** Members are other xPanel servers, reached at a saved address on xWHM port 2087, so the cluster does not
  depend on the DNS it serves. The client finishes the TLS handshake, compares SHA-256 of the peer's public key with the
  saved pin, and only then creates the request on that socket. The token is never written to an unchecked peer.
- **The pin is the public key, not the certificate.** The management certificate renews every 60 to 90 days, so a
  certificate pin would break every cluster at each renewal. `certbot` now runs with `--reuse-key`, which keeps the key
  and the pin across renewals. Rotating the key is an operator act: the member shows `pin_mismatch` until the new pin is
  proved and saved.
- **Trust is per member.** An inbound token is 256 random bits, stored as a hash, bound to one address and to the root who
  issued it. It cannot reach any route outside `/api/cluster/dns/`. These routes authenticate like the WHMCS route, so like
  it they are outside the session route matrix. The Panel Access list for xWHM still applies, so a member's address must
  be allowed there.
- **Zone sync is application level, not AXFR.** AXFR would need TSIG keys and would not carry ownership. A copy is the
  rendered zone file, which holds the mail records and the published serial, parsed under the zone import rules and saved
  as an ordinary zone with no account and a `replica` mark. The reconciler publishes it, keeping the source serial, so
  every member answers the same SOA serial. Secondary peers through NOTIFY and AXFR stay for third-party nameservers.
- **Conflicts are refused, not merged.** An account zone or another member's copy is never overwritten, even when forced.
  A copy edited on the member, a repeated serial with different records, or an older serial can be overwritten from the
  source after a confirmation. Copies are never sent on, so zones cannot loop. A full mesh needs each pair configured.
- **No daemon.** The agent's existing minute tick does one `stat` of the zone directory while nothing changed. A member
  gets one heartbeat in five minutes so an outage shows without a zone change. A failing member backs off to one attempt
  per hour, and passes are bounded to 64 commands.
- **DNSSEC.** A signed zone is withheld, with a visible state, because a member without the keys would answer unsigned
  under a published DS. If the key store cannot be read the zone is withheld too. Copying keys is not built.
- **Same backend rule.** Every member is PowerDNS with the BIND backend, so the cPanel rule cannot be broken. Resellers
  cannot run their own cluster: the tool is root only.

Exercised: the real peer handler with two state stores, and the real pinned client against a loopback TLS server. Only two
real hosts can prove nginx ingress, the address seen through it, PowerDNS answering after commit, and an outage across a
network.

## Database server profiles

- **One writer, in the agent.** Metadata is in `/etc/xpanel/db-profiles.json`. Each credential is in its own root-only option
  file, read by the client through `--defaults-extra-file`. The API holds nothing, and a listing is projected field by
  field.
- **Activation swaps the admin option file.** The adapter already verifies that file before each command, so it now also
  learns the transport from it: a `host=` line means TCP. Every instance follows at once, with no restart.
- **Activation is refused while databases or database users are saved.** cPanel warns and switches. Here backups and
  reconcile address one server, so switching would back up empty databases and recreate them on the new server while the
  real data sat on the old one. Nothing is migrated, and `PROFILE_HAS_DATABASES` says why. Owner review is requested.
- **A profile identifies its server before it sends a credential.** TLS is not optional. Each profile holds one PEM
  certificate, the CA of the server or its own self-signed certificate, and its option file sets `ssl-ca` and
  `ssl-verify-server-cert`, so the client checks the certificate and the host name during the handshake. A spoofed host
  fails there with `tls_failed`, and validation runs before activation.
- **Validation trusts the server's answers.** One connection reads the version, the TLS cipher and the grants. A session
  without a cipher fails with `tls_not_negotiated`, whatever the client flags did. The
  address the server saw is kept, and reconcile creates each database user for that host too.
- **Host-local tools refuse under a remote profile:** the root password, phpMyAdmin sign-on and the engine upgrade return
  `remote_profile_active`.

Not built: bootstrapping a superuser over SSH and choosing a server per database. cPanel's "one panel per remote server" is
not detected.

Exercised: every path above with a fake MariaDB client command. A real remote MariaDB, its TLS and its grant output format
are not proven.
