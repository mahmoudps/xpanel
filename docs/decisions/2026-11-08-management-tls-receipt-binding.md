# Management TLS files in the install receipt

Date: 2026-11-08.

## Decision

The install receipt no longer pins the management ingress (`/etc/nginx/conf.d/xpanel-management.conf`), the challenge (`/etc/nginx/conf.d/xpanel-management-challenge.conf`) and the ingress credential include (`/etc/nginx/xpanel-management/ingress-secret.conf`) to their install-time inode, size and hash. `scripts/management-tls.mjs` rewrites them on renewal (the ingress names the certificate generation), on rebind, on the stale-ingress repair, and on rollback (identical bytes on a new inode). With the pin, the first upgrade after any of these refused with `OWNED_FILE_DRIFT`.

Their bytes are now bound to the activation record `/var/lib/xpanel-management-tls/activation.json`, which the same lifecycle transaction writes after a settled reload: `files.ingressSha256`, `files.includeSha256` and, from this release, `files.challengeSha256`.

## What is still checked

Every check runs on each `assertOwnedFile`, so upgrade admission, the installation transition, recovery and coordinator rotation all use it:

- every ancestor directory root-owned and not group or world writable;
- a regular file opened without following symlinks, link count 1, owner and group root;
- the exact mode the receipt recorded, and the recorded device;
- the bytes named by the activation record, which must itself be a root-owned `0600` record of kind `xpanel-management-tls-activation`.

A foreign write of these files changes bytes the activation record does not name, and refuses. Only root can rewrite the record, and root can also rewrite the receipt, so the record binding gives the same protection the install-time pin gave, without refusing the product's own writes.

The renewal units stay pinned. `management-tls.mjs` writes them only in `prepare`, which runs before install capture, and the installation transition re-records them on each upgrade.

## Receipts and records

No schema changes. The receipt keeps each file's install-time inode, size and hash as observations, and readers still require them. An activation record written before this release has no `challengeSha256`: the challenge then stays bound to its install-time bytes until the next settled lifecycle writes the field.

## Hosts on an older release

The check runs from the code that performs the operation. An upgrade rotates the coordinator from the target release, and `root-operator-entry.mjs` admits only the rotated helper, so the upgrade from 0.1.33 or 0.1.34 to this release runs this check. The installed 0.1.33 and 0.1.34 code still holds the pin in its own lifecycle commands: `xpanel-ctl update`, `upgrade` and `recover` run from `/opt/xpanel/current`, and its root operator once a rotation rollback returns the coordinator to it. On such a host, after a renewal, rebind or the 0.1.34 ingress repair, those commands refuse until the host moves forward: rotate to this release and upgrade. Do not edit the receipt.
