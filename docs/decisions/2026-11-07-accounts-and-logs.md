# Accounts, logs and file exports

Scope: User Manager, Email Disk Usage, Git History Browser, Raw FTP Log Download, Account Repair, Service Logs, Access Log Security Analysis, File Sharing.

## Choices

- **User Manager adds a page, not a model.** A service user is already one login with email, FTP and Web Disk flags, so the create, edit and delete routes the mail pages use serve this page too. There is nothing to link or merge.
- **Email Disk Usage runs as the mail server, not as an IMAP session.** The account owner has no mailbox password. `doveadm mailbox status` and `doveadm expunge` name one literal mailbox, and a typed query is parsed against fixed keywords, so an empty query or `ALL` from the form cannot run. The all-messages preset is a separate choice, and the confirmation names the folder.
- **The Git viewer is read-only by construction.** Each view is a fixed argv rebuilt by the executor, run through the same account jail as the rest of Git, after the repository passes the same shape and configuration checks. A revision is a hash, a ref name or `HEAD`, and never carries rev-parse syntax. A diff over the output bound is stated, never cut.
- **The raw FTP log is rebuilt from events.** pure-ftpd writes to the journal and has no per-domain file. A domain is the suffix of the login, so a connection before sign-in names no domain and is left out.
- **Service Logs read what the server reports.** The slow log and error log paths come from `SHOW GLOBAL VARIABLES`, and a path outside the package log directories or the data directory is not opened as root. An empty `log_error` means the journal. Slow recording is two Tweak Settings rendered into the existing MariaDB drop-in, so turning it on restarts MariaDB once, as any change to that file does.
- **Security analysis is pattern matching over the latest 4 MiB of one site log.** It reports attempts, not break-ins, and blocks nothing. The tail keeps it within the 1 vCPU budget and the report says when it was partial.
- **Account repair is ownership plus a re-render.** Ownership uses the same find, `-execdir` and `chown -h` shape as Repair Mailbox Permissions, so a tenant cannot steer it through a symlink, and a job reads the result back. Everything else a broken account can need is already rendered from saved state, so the second fix re-renders. Modes are left alone.
- **NFS needs a running server.** `/proc/fs/nfsd/threads` decides, because a stopped server keeps a stale `etab`. The server is a Software Center component and is not part of the base install: it would cost memory on every host for a feature few use.
- **Share links read one file through the agent, on owner conditions of 2026-11-07.** A token is 32 random bytes and only its SHA-256 is saved, so the state file cannot be replayed. An expiry is required. The public route takes no path: its token hash selects a saved row, and the agent re-checks that row and reads only that file, as a download. Each home component opens relative to its parent with `O_NOFOLLOW`, so a symlink at any depth or one swapped in mid-walk is refused, and the opened file must be a regular, single-link file of the account with the device and inode saved at creation. Revoking removes the row, so a revoked token is an unknown token by construction. Unknown, expired, revoked, malformed and unreadable all give one answer. Misses are limited to 20 per address per 10 minutes before any lookup, for live tokens too, since a different answer would confirm a guess. The API cannot read account files and a public request has no principal, so the agent call runs as the link's creator: a disabled creator ends their links. A use that cannot be audited is not served, and a link that cannot be audited is withdrawn. The account listener carries the route, under its address filter.

## Not built, with the reason

- **Multi-Server Nodes and Cross-Node File Transfer.** Both need the node channel of `temp/w8-cluster`. Management is that branch's Linked Server Nodes. Two-pane transfer waits for the channel; its Transfer account button already links to Transfers there.
- **Share links to directories, access codes, and links that follow a replaced file**: one link is one file, and the file is pinned at creation.
- **Side-by-side diffs, Git snapshots, feeds and regular expression search.** Listed in the scope note.
- **The emailed set-your-password link** of User Manager needs a mailbox-principal token flow that does not exist.

## What only a real host can prove

`doveadm expunge` and its size and date terms on Dovecot 2.3 and 2.4; the slow log path and the distribution's rotation on EL and Debian; journal and file sources of the error log; the git argv on the oldest profile's git; `find -execdir chown` as root on a home with a real quota; NFS export and read-back with a running nfsd on all five profiles; a share link through the real ingress, with `extractClientIp` seeing the client and not the proxy, and the walk through `/proc/self/fd` inside the agent unit's sandbox.
