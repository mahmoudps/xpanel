# Owner tools (2026-11-07)

Web apps run as one systemd unit per application, not Passenger. Staging and building are transient oneshots as the
account; the app unit starts through `OnSuccess=` and `ConditionPathExists=<root>/.xpanel-deployed`, so a reconcile during
a build cannot start a half-built tree and no agent loop waits for a build. Static sites run on the system Python as one
unit, so stop, restart and logs match server apps and the document root is never overwritten.

Images use Python Pillow in the account sandbox, passed as `python3 -I -c`, not ImageMagick: Pillow is in the base
repositories of the supported profiles while ImageMagick needs EPEL on EL. Pillow and cpanminus are optional
software-center components, because a missing package in the bootstrap list would fail the whole installer. Limits per
run: 50 MiB input, 40 Mpx, 256 MiB memory, 60 s, 200 images. These limits are set by reasoning, not by measurement on a
1 vCPU / 1 GB guest.

Website backups stay in the root-only backup store. The account writes and reads the tree through tar as the account,
and root never walks the document root.
