# Zstandard backup archives

Date: 2026-11-06. Scope: scheduled server backups (WHM Backup Configuration compression setting) and every reader of their archives.

## Decision

- `zstd` is a bootstrap package of all supported OS profiles (Ubuntu 22.04 and 24.04; CentOS Stream, AlmaLinux and Rocky Linux 9 and 10) in `packages/os` and `scripts/install.sh`.
- A schedule saved with `compress: "zstd"` writes every archive of its runs, including the control snapshot, as `.tar.zst` with `/usr/bin/zstd -q -c -3 --check --single-thread`, behind the existing `nice -n 19` / `ionice -c 2 -n 7` prefix. `gzip` schedules keep `gzip -c -n -6` and `.tar.gz`.
- The file name suffix declares the codec. Every reader uses that codec only: `tar --list/--extract --zstd` for listings, part restores and home restores, and a low-priority `zstd -d` child (argv only, no shell, nothing on disk) for the in-process archive inspection and file restore. Bytes that do not start with the codec's magic number are rejected.
- Integrity: the frame carries an XXH64 content checksum (`--check`). An archive counts as verified, and is uploaded, only after the full read-back (`tar --list --zstd`), where zstd checks every block and the checksum; a nonzero exit is `integrity_failed`, the same gate as the gzip CRC.
- Missing binary at runtime: the runs view reports `unsupported_compression`, a run refuses with `PRECONDITION_FAILED` and `backup_compression_unavailable`, and a failed read of a `.tar.zst` while zstd is absent reports `backup_compression_unavailable` instead of damage. The API saves the schedule as desired state; it no longer refuses `zstd`.
- Per-account runs without a saved schedule and the account home backup keep gzip.

## Measurements

Ubuntu 22.04 qualification guest, zstd 1.4.8, GNU tar 1.34, unprivileged user, GNU time. The compressors are single-threaded, so the CPU seconds carry over to a 1 vCPU host, where wall time is at least the CPU time.

Mixed tree: a 340,121,600-byte tar of a source checkout with its dependencies and Git objects (text, compressed packs and binaries), the Python 3 standard library, and 64 MiB of random data standing in for already-compressed uploads.

| Command | CPU (user+sys) | Max RSS | Output bytes | Ratio |
|---|---|---|---|---|
| `gzip -c -n -6` (previous) | 12.42 s | 2.2 MB | 152,680,866 | 44.9% |
| `zstd -1 --single-thread` | 1.08 s | 3.3 MB | 156,848,087 | 46.1% |
| `zstd -3 --single-thread` (chosen) | 1.61 s | 5.6 MB | 146,745,653 | 43.1% |
| `zstd -3 -T1` | 1.76 s | 52.9 MB | 146,953,386 | 43.2% |
| `zstd -6 --single-thread` | 4.19 s | 9.1 MB | 142,662,032 | 41.9% |
| `zstd -9 --single-thread` | 9.47 s | 11.2 MB | 139,155,221 | 40.9% |
| `zstd -12 -T1` | 18.18 s | 125.8 MB | 137,653,803 | 40.5% |

Text-only tree (112,527,360-byte tar of source text and the Python library): `gzip -6` 3.83 s, 2.0 MB, 25.0%; `zstd -3 --single-thread` 0.55 s, 5.5 MB, 23.0%; `zstd -9 --single-thread` 2.89 s, 11.0 MB, 19.7%.

Reading the mixed tree back: `gzip -d` 1.56 s, 1.9 MB; `zstd -d` 0.34 s, 4.7 MB; `tar --list --gzip` 1.91 s, 3.0 MB; `tar --list --zstd` 0.53 s, 4.8 MB. The level 3 frame uses a 2 MiB window. One changed byte in the middle of the archive made `zstd -t` exit 1 and `tar --list --zstd` exit 2.

## Why level 3 on one thread

Level 3 cuts compression CPU by about 87% against gzip -6 and still writes smaller archives, and restores read about four times faster. On a 1 vCPU host every backup second competes with the sites for CPU, disk and page cache even at the lowest priority, so the shortest backup window wins over the 2 to 3 percentage points that level 9 saves at gzip's CPU cost. `-T1` still starts a worker thread with about 53 MB of buffers; `--single-thread` keeps the compressor near 6 MB, which matters on 1 GB beside MariaDB and the sites.

## Open

Native runs on Ubuntu 24.04 and EL 9/10, a full scheduled run as root against real accounts, and restore of a remote `.tar.zst` copy on a 1 vCPU / 1 GB host are not yet qualified.
