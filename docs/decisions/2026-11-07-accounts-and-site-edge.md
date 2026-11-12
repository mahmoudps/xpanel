# Accounts and site edge tools (Wave 5, W5-A)

Owner decisions 3, 4, 5 and 9 of 2026-11-07 apply. cPanel is the reference; these are the places where this architecture differs.

## Default page for an empty public_html

Apache gets the page as the last relative `DirectoryIndex` entry (`.xpanel-page/index.html`), resolving at `/` to an alias for a root-owned directory outside the document root. It answers 200 in the document root. An `.htaccess` `DirectoryIndex` still wins, because that file merges after the vhost `Directory` section.

Rejected: nginx `error_page 403` with `proxy_intercept_errors`, which also hides a site's own 403. A `<Location>` section, which overrides `.htaccess` and would break a site's custom index. Because the fallback entry is relative rather than root-anchored, subfolders without an index file fall through to `Options +/-Indexes` (403 or directory listing).

OpenLiteSpeed has no index fallback, so it keeps its own answer for an empty site and gets the suspended page only.

## Page scopes

Pages are rendered at reconcile into `/usr/share/xpanel/{default,suspended}/<scope>/index.html`, one file per scope and not one per site. Disk use is two small files per reseller and template that has accounts. `%domain%` is not offered, because one file serves many sites. The cPanel shipped pages do not name the domain either.

Order: plan template text, then the owner's page, then root's, then the shipped page. The plan text already existed as a saved field, so publishing it deletes the "saved only" state.

## Rearrange an Account

A move is a host job, because a large home outlives any request. The account is held suspended with `homeMove` set, which also defers its mail: a message delivered behind the copy would be lost with the old directory.

One filesystem is a `rename`. Between filesystems: `cp -a` to a hidden name, `diff -r --no-dereference`, then rename into place, so a partial copy never holds the final name. State changes only after the files arrived, and the old directory goes only after the new one served a clean reconcile.

Each step has the host job limit of one hour. A home too large for that fails, and the account returns to its old home unchanged. A job that died with the agent is settled from what is on disk: a published directory was compared before it took its name, so it finishes the move.

Quota follows only to a root whose filesystem has quota enabled. The disk usage report still reads the `/home` filesystem, so a moved account shows no usage row until that report reads each root.

## Runtime locales

A copy is a PO catalog saved under `extended/locales/copies/`. It joins the registry at panel start, like any uploaded catalog, because client catalogs are cached assets. Tool and theme strings come from the source locale. Eight copies at most: each holds a full catalog in API memory.

## Email All Users

The confirmation must repeat the digest of the reviewed message and recipients, so a changed account list or a changed message cannot be sent unreviewed. One request sends in sequence, to at most 5000 accounts.

## Panel paths and redirection

The panels answer only on their own public host with its certificate. cPanel's closest-match choice between origin and hostname has one answer here, so the tweak is one switch. `/whm`, `/xpanel` and `/webmail` on an account site redirect to that origin.

## Not measured

No move, page or copy has run on a host in this package. Timings and memory of a locale copy are unmeasured.
