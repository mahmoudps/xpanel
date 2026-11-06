# File Manager compress and extract

Decided 2026-11-06. The owner asked for the most efficient safe design, measured.

## Constraints that decide most of it

- Archives come from the account, so they are untrusted and are never parsed as root.
  The confined file worker already runs as the account UID. It runs in a transient service:
  `MemoryMax=64M`, `MemorySwapMax=0`, `TasksMax=1` and `CPUQuota=100%`.
  Every path goes through `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`.
- `TasksMax=1` lets the worker run only its own process. It cannot fork `tar`, `gzip` or `unzip`.
- The install has no `-dev` packages, so no zlib, bzip2, zstd or libarchive headers.
  OS package lists are out of scope for this change.

## Candidates measured

Qualification VM: Ubuntu 22.04.5, kernel 5.15, 6 vCPU Intel i7-7700 at 3.6 GHz, warm page cache, same disk for input and output.
Tree: 5,000 files, 202,014,739 bytes. That is 4,900 source-like text files (about 100 MB, cut from the
repository's TypeScript) and 100 incompressible 1 MB files (about 100 MB), in 360 folders.

Each run had a tiny C parent. It took wall time and `getrusage(RUSAGE_CHILDREN)` after `waitpid`, so CPU and
peak RSS cover the command and every child it waited for (GNU tar includes its gzip or zstd child).

Each "helper" row is the shipped helper code, through the unprivileged test harness. Its extract time
includes the `syncfs` before publication. The other candidates do not sync, which is most of the wall/CPU gap.

Compress (tree to archive):

| Candidate | Format | CPU s | Wall s | Peak RSS MiB | Size bytes |
|---|---|---:|---:|---:|---:|
| GNU tar 1.34 | tar | 0.25 | 0.25 | 3.4 | 204,410,880 |
| GNU tar + gzip 1.10 | tar.gz | 6.45 | 6.22 | 3.4 | 125,765,979 |
| GNU tar + zstd CLI | tar.zst | 1.05 | 0.71 | 51.5 | 123,959,941 |
| GNU bzip2, zip | tar.bz2, zip | not installed on this image | | | |
| helper | zip | 5.39 | 5.71 | 2.8 | 128,161,702 |
| helper | tar | 0.32 | 0.72 | 2.1 | 204,403,200 |
| helper | tar.gz | 6.00 | 6.31 | 2.3 | 125,797,120 |
| helper | tar.bz2 | 17.74 | 18.32 | 8.3 | 120,621,217 |
| helper | tar.zst | 0.86 | 1.12 | 5.7 | 123,765,658 |
| libarchive 3.6.0 | tar.gz | 5.95 | 5.99 | 5.7 | 125,802,474 |
| libarchive | zip | 5.24 | 5.35 | 5.7 | 128,588,070 |
| libarchive | tar.bz2 | 17.43 | 17.44 | 11.2 | 120,609,814 |
| libarchive | tar.zst | 0.81 | 0.81 | 8.6 | 123,768,887 |
| Node 26.12.1 zlib | tar.gz | 6.05 | 6.20 | 93.5 | 125,843,678 |
| Node zlib | tar.zst | 2.28 | 2.16 | 93.1 | 123,650,962 |

Extract (archive to a new folder):

| Candidate | Format | CPU s | Wall s | Peak RSS MiB |
|---|---|---:|---:|---:|
| GNU tar | tar | 0.29 | 0.29 | 2.8 |
| GNU tar + gzip | tar.gz | 1.39 | 1.06 | 2.6 |
| GNU tar + zstd | tar.zst | 0.58 | 0.42 | 4.2 |
| helper | zip | 0.72 | 2.47 | 2.7 |
| helper | tar | 0.26 | 0.98 | 1.8 |
| helper | tar.gz | 0.71 | 1.83 | 2.1 |
| helper | tar.bz2 | 8.80 | 9.99 | 5.2 |
| helper | tar.zst | 0.37 | 0.71 | 4.5 |
| libarchive | tar.gz | 0.64 | 0.66 | 5.6 |
| libarchive | zip | 0.81 | 0.83 | 6.3 |
| libarchive | tar.bz2 | 10.20 | 10.57 | 8.1 |
| libarchive | tar.zst | 0.50 | 0.50 | 7.3 |
| Node zlib | tar.gz | 1.43 | 1.16 | 72.9 |
| Node zlib | tar.zst | 1.36 | 1.27 | 75.0 |

An idle `node -e 0` already peaks at 41.1 MiB. The helper extraction of the tar.zst archive matched the
source tree byte for byte (`diff -r`).

## Choice

The confined C helper does the work in process. It uses the system zlib, libbz2 and libzstd, which it loads by
soname (`dlopen`) after it drops to the account UID. Its own small tar (ustar, pax, GNU long names) and zip
(stored, deflate, zip64 sizes) code wraps them.

- Efficiency: this has the same codec cost as the best candidate, because the codec dominates and is the same
  library. It also has the lowest peak RSS (1.8 to 8.3 MiB), so it fits the 64 MiB worker with wide margin.
- Node zlib would parse untrusted data in the root agent, needs 73 to 94 MiB, and cannot use `openat2`.
- System tools need `TasksMax` above 1 to fork their compressor. bzip2, zip and unzip are missing on a stock
  Ubuntu 22.04 image, and the zstd CLI peaks at 51.5 MiB.
- libarchive spends the same CPU with more memory. Its runtime library is not a guaranteed dependency on every
  supported OS (on this image only fwupd pulls in libarchive13), and it parses many formats we do not offer.
- The package manager itself keeps zlib, libbz2 and libzstd installed: dpkg 1.21 pre-depends on zlib1g,
  libbz2-1.0 and libzstd1 (observed on Ubuntu 22.04). On EL the rpm libraries link the same three; that was not
  observed in this run. No header or package is added. A library that cannot load refuses only its formats, with
  `PRECONDITION_FAILED` and reason `archive_format_unavailable`. It never reports false success.
  tar.zst is therefore offered when libzstd loads in the worker. That library, not the CLI binary, does the work.

Formats: compress writes zip, tar, tar.gz/tgz, tar.bz2/tbz2 and tar.zst/tzst. The name suffix chooses the format,
so a name never lies about its content. Extract detects the format by content: zip, tar, gzip, bzip2 or zstd tar,
and a single .gz, .bz2 or .zst file (decompressed beside its name).

## Defences

- Every entry is created under a hidden staging folder with `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)`.
  The staging folder is published with no-replace renames, never over an existing item. Any refusal removes it.
- Refused entries: absolute, drive-letter, `..`, empty-segment, backslash, control-byte and non-UTF-8 names;
  `.trash` and staging names; deeper than 32 levels; symbolic and hard links; device and FIFO entries; sparse,
  encrypted and multi-volume archives; unknown zip methods.
- Modes are clamped to the 0640 file and 0750 folder ceilings, with owner read/write kept.
  Setuid, setgid, sticky and execute bits never survive. Archive owners are ignored.
- Bombs: 10,000 entries; 512 MiB of content, or the plan disk quota if that is smaller; more than 250 times
  expansion once past 16 MiB; zip sizes declared up front and enforced exactly with CRC; overlapping zip entries
  refused; zstd window at most 16 MiB; kernel quota (`EDQUOT`) refuses and cleans up.
- Compress reads only account-owned regular files and folders. Like copy, it refuses links and special files.
- Archive operations get a 120 s worker. At most 2 run at once on a host (`archive_capacity_busy`), so browsing
  keeps free worker slots. The agent socket for the account file route waits 150 s.
  512 MiB is the limit because bzip2 -9 runs at about 11 MiB/s on the core above. A slower 1 vCPU host must
  still finish within the worker budget.

## Not done

- Compress works on one selected item; cPanel can compress a multi-item selection. To combine several items,
  compress the folder that holds them.
- There is no progress bar. The result is shown after it is read back.
- A worker killed at its timeout leaves its hidden staging entry, as copy does today.
