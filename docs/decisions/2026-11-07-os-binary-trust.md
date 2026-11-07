# Trust in distribution-owned binaries

Date: 2026-11-07.

## Decision

xPanel no longer compares `/usr/bin/systemctl` to a recorded hash, and nothing compares `nginxSha256`. Unattended security updates replace those files, and a hash pin turned every such update into a permanent upgrade refusal (`TRUSTED_FILE_HASH_DRIFT`).

## Threat reasoning

`/usr/bin/systemctl` is owned by the distribution package manager. Only root can replace it, through a path whose every ancestor must already be root-owned and not group or world writable. An attacker who can do that already has root, and the same root can rewrite the receipts that hold the hash, so the pin adds no protection against that attacker. It only catches legitimate package updates.

What matters is that a lower-privileged user cannot put a file there, and that the file checked is the file executed. The trusted-file checks still cover both, on every use:

- regular file, opened without following symlinks;
- owner and group root, no group or world write, no setuid or setgid;
- link count 1, so no hard-link trick;
- every ancestor directory root-owned and not group or world writable;
- execution through the same open descriptor (`/proc/self/fd/3`), with inode, size and times checked again after use.

Hash pins stay on what the product ships and owns: Node, the package manager, the native helper, the release tree, receipts and unit files. Those change only through a signed release, so a difference there is real drift.

## Receipts

Installed hosts carry receipts with exact key sets, so `runtime.systemctlSha256` and `runtime.nginxSha256` stay as install-time observations and readers still require them. No schema changes. Coordinator rotation copies the old value forward unchanged.

A retry of an interrupted install used to compare a fresh receipt with the stored one, including both hashes. It now leaves them out of that comparison and keeps comparing everything else.

## Hosts on an older release

Coordinator rotation runs from the next release, so a host whose systemctl already changed can rotate and upgrade with this code. The coordinator of the older release still holds the old check: if rotation has to roll back on such a host, that older coordinator refuses to serve until the host moves forward.
