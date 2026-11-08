# Site applications from the signed catalog (2026-11-07)

Owner decisions 2026-11-06 items 11 and 13: same outcome as cPanel Site Software, on the signed catalog, within 1 vCPU / 1 GB.

**Bundle format.** `xpanel-files-v1` is one canonical JSON header line (identity, `setup`, file rows) followed by the raw file bytes in
header order. The agent runs with a 64 MiB JavaScript heap, so file bytes stay in buffers outside it. The former JSON with base64 content
would have failed there at about 16 MiB, and a real application is 80 MiB. Limits: 128 MiB, 8192 files, 32 MiB a file. A bundle has no
tar, link, device, executable bit or script, so nothing is unpacked in the usual sense and no bundle code runs at install.

**Trust.** The signed catalog names each release by SHA-256 and size. The whole file must match before anything is read from it, on upload and
again before every install. Root uploads releases in 512 KiB chunks through the normal JSON transport, so no raw path through the API is needed,
and the agent makes no outbound request. An interrupted upload starts over.

**Setup.** `setup.database` asks for a database and its own user with a generated password. `setup.config` names a bundled template and the
file to render, with the fixed placeholders `__XPANEL_DB_NAME__`, `__XPANEL_DB_USER__`, `__XPANEL_DB_PASSWORD__`, `__XPANEL_DB_HOST__` and
`__XPANEL_SECRET_1__` to `__XPANEL_SECRET_8__`. The rendered file belongs to the site owner: it is mode 0640, never a managed file, and updates
leave it alone. The panel does not create the application administrator, because that would need bundle code to run as the panel. The application
finishes its own setup when its site is first opened.

**Worker.** Each stage is one short Python process inside the account jail, the same jail as File Manager commands, with `RuntimeMaxSec` below the
stage deadline. It opens every path relative to a held directory descriptor with `O_NOFOLLOW`, so a link the site planted cannot redirect a write.
Files get the account's uid, so disk quota applies. Python gives real `dir_fd` calls, and Node has no `openat`. Adding a transaction and SHA-256 to the C helper would have added code that cannot be tested on its own.

**Transaction.** `~/.xpanel-apps/journal/<key>/` holds preimages of the files the change touches, written and fsynced before the first change. New
files are written to temporary names first, so a full quota changes nothing the site can see. The commit point is the rename of the staged record over
`~/.xpanel-apps/instances/<key>.json`. Recovery restores preimages, and a file that is neither its preimage nor what the transaction wrote is someone
else's data: recovery stops, keeps the journal and reports it. After a lost process the journal locks the target until the owner presses Recover.

**Revisions.** The revision covers the record, the digest of every managed file and the names at the top of the install directory. It does not walk
the whole tree. A live site writes uploads and caches all the time, and a revision over them could never be reviewed. An edited managed file refuses
update and rollback with `application_files_modified`; uninstall is still allowed, because the edit is in the reviewed revision and in the recovery copy.

**Records in the home.** The record travels with the account backup, and the database is an ordinary account database, so "back up with the account"
needs no new backup part. The record is account-writable, so it is read as untrusted input: it selects only that account's own objects, a row whose
name does not match its directory is dropped, and every change runs as the account. WHM reads only the first line of each record, as root through
descriptors, so listing every account starts no process and a list of 8192 files never reaches the agent heap.

**Database.** Creating, retiring and discarding a database mutate desired state and then run the normal account reconcile, so they run outside the
account lease as their own job step. Uninstall moves the database to the trash, where its usual retention applies, and deletes the generated user. A failed
install discards what it created. A failure after the commit of an uninstall leaves the database in the Databases page, and the job reports it.

## Measurements

Measured on the Ubuntu 22.04 lab guest (6 vCPU, Python 3.10) with a synthetic bundle of 3300 files and 80 MiB, the size of WordPress.

| Stage | One fsync per file | One sync |
|---|---|---|
| Apply | 31.3 s | 12.0 s |
| Observe | 1.9 s | 0.4 s |
| Commit | 0.2 s | 0.1 s |

The worker peaks at 20 MiB RSS. The stage holds the account lease, which also pauses desired-state writes, so one `sync` replaced an fsync per file. It can
wait on other accounts' dirty pages on a busy host, and the stage deadline bounds that wait. The panel's fsync of each directory and of the journal stays.
