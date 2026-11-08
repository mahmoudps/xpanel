# Demo mode, hooks, plugins, theme packages and the signed catalog (2026-11-07)

Owner decisions 2026-11-06 items 11 and 13 and 2026-11-07 items 5 and 10: same outcome as cPanel/WHM, adapted to desired
state in files, the 1 vCPU / 1 GB budget and two isolated UI themes.

**Demo mode.** `extended/panel/demo-mode.json` lists account ids. `assertRequestAuthorized` refuses every non-read API
request of a principal of a listed account with `demo_mode_readonly`, so the pages, API tokens and the command-line API
share one gate. A list that cannot be verified refuses instead of admitting, because showcase credentials are often
public. Mail, FTP and SSH do not pass through the API, so the page tells root to give a showcase account none of them.

**Hooks.** Only root-owned files in `/usr/local/libexec/xpanel/hooks` register, and their SHA-256 is pinned. Each run
re-checks ownership, mode and digest, runs as `nobody` through `setpriv --no-new-privs` with an argv array, gets a timeout
and is audited. Runs are serialized with a queue of 16, so a burst never starts parallel children on one vCPU. The events
(account create, suspend, unsuspend, terminate) need no root, so no root hook exists. A pre-stage blocking hook that fails
stops its action, and a registry that cannot be verified refuses the action, because it could hide a blocking hook.

**Account enhancements** stay as saved entitlements. Their consumer is the hook event: `enhancements` holds the effective
values of the account (plan overlaid by account), or `null` when the saved document cannot be verified. An add-on hook
decides what an enhancement means, as a cPanel add-on does; the panel itself enforces no limit from them.

**Plugins.** cPanel's generator writes a tar archive of `install.json` and icons. xPanel writes one JSON document
(`xpanel-plugin-package-v1`) and also reads that archive: a `.tar.gz` of up to 1 MiB, 4 MiB unpacked, walked in memory,
so nothing reaches the disk and no path can escape. `install.json` sits at the root or in one directory. Groups give
names, `order` gives the sequence, and the name comes from the file. A link, device, foreign entry type or a `uri` into
the plugin is refused with a stable reason. The items are links only; no plugin code runs in the panel. An address is a panel path or an `https` URL. A PNG is checked
by its signature and IHDR size. An SVG passes an allow-list scan of drawing elements and attributes, is refused rather
than sanitised, is served with `default-src 'none'; sandbox` and is shown through `<img>`. An item's plan feature is an
existing xPanel tool id, or `plugin:<key>` for a key the package adds, as cPanel's `featuremanager` does: the Feature
Manager lists it while the plugin is installed. The prefix keeps it apart from every catalog key. A name that exists needs `overwrite=true`;
an item id held by another plugin always conflicts, so an install never changes a plugin it does not name.

**Theme packages** carry only colors and corner radii over a built-in theme, with light and dark token sets and a
4.5:1 contrast check. They contain no CSS, markup or files, so nothing can leak between themes or move a control. The
cPanel rule about required password-change templates has no meaning here; the equivalent is `missing_required_token`.
Preview opens one page with `?previewTheme=<id>`: only root gets it, only for a registered theme, under a banner that
says so. Nothing is saved, and the next page uses root's own theme.

**Signed catalog.** The trust anchors are the release signing keys in `/etc/xpanel/release-keys.json`. The agent verifies
a stored catalog on every read and before every install, and keeps the highest accepted sequence, so an older catalog is
refused. Root then chooses which applications accounts may install. Installing is in `2026-11-07-site-applications.md`.

## Measurements

Measured on the Ubuntu 22.04 lab guest (6 vCPU, Node 26) with synthetic packages at the limits.

| Measure | Result |
|---|---|
| Largest plugin package (16 items, 16 KiB icons) | 351,694 bytes, 0.6 ms to parse and validate |
| Home read, 32 largest packages, no cache | 64 ms a read, 113 MiB RSS growth over 20 reads |
| Home read, 16 largest packages, parsed files cached by stat | 7.5 ms mean over 20 reads, 19 MiB RSS growth |

The second row is why the limit is 16 packages and the home read keeps parsed files until they change.

None of these features adds a daemon, timer or polling loop: hooks run only inside a lifecycle action, and packages are
read from small state files on request.
