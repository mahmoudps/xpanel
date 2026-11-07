# Web extras: cache purge, IP Blocker, Apache handlers, Leech Protection

Date: 2026-11-07. Scope: per-account controls that act on the nginx edge and the Apache backend.

## NGINX cache purge

Decision: every account has a cache key epoch. `proxy_cache_key` starts with `$xpanel_cache_epoch`, set per server block from `extended/edge/cache/<accountId>.json`. A purge writes a new epoch and the next configuration generation reloads nginx. The account switch (cPanel NginxCaching) renders its sites without `proxy_cache`, and they answer `X-Cache-Status: BYPASS` so the state stays visible.

Open-source nginx has no purge. Three options were measured on the Ubuntu 22.04 qualification guest, unprivileged, with one shared zone holding 100 hosts, and the scan pinned to one core:

| Option | Measure | Result |
|---|---|---|
| A. Walk the cache tree, read each header, unlink entries of one host | 10000 entries | 1.40 s wall, 1.39 s CPU, 84 MB peak RSS |
| A | 40000 entries | 6.86 s wall, 3.85 s CPU, 87 MB peak RSS |
| B. Epoch in the key, one reload | any cache size | `nginx -t` 6 ms, first MISS 7 ms after the reload, next request HIT |
| C. One zone per account (the cPanel ea-nginx layout) | 100 accounts | `nginx -t` 8 ms, nginx RSS 12.2 MB |
| C | 500 accounts | `nginx -t` 21 ms, nginx RSS 26.5 MB |

A costs a Node process of 87 MB on a 1 GB host and grows with the whole cache, not with the account. C grows with every account whether it uses the cache or not, and splits the shared `max_size`. B costs one short string per site and is constant, so B wins.

Limit: old entries stay on disk until `inactive=60m` removes them. They are unreachable at once and count against the shared `max_size`, which nginx enforces as before. Purge takes effect with the reload, not with the API reply; the page says so.

## IP Blocker

Decision: deny lines at the nginx edge, rendered into every server block of the account from `extended/edge/ip-blocker/<accountId>.json`. Apache sees the edge on loopback, so `.htaccess` address rules could never match a visitor. Ranges are stored as the exact covering CIDR blocks. Host names are resolved once, when added, because nginx `deny` takes addresses only. Loopback is refused: blocking it takes every site down.

## Apache handlers

Decision: `AddHandler` lines in a marked block of the domain `.htaccess`, through the checked save of the other web directives. `server-info` and `server-status` are refused because they disclose every tenant. `send-as-is` and `imap-file` are refused because their modules are not loaded. `cgi-script` needs the per-account mpm-itk identity. `server-parsed` runs with `IncludesNOEXEC`.

## Leech Protection

cPanel asks Apache a `RewriteMap` program on each request. A `RewriteMap` cannot live in `.htaccess`, so it means one global coprocess that every request of every site waits on. That spends the 1 vCPU budget on every tenant to serve a rare feature.

Decision: Apache writes one tab-separated line per signed-in request to the root-only `auth.log`. The agent reads new lines on its existing minute tick and keeps a two-hour window of distinct addresses per folder and user. While a user is over the limit, the folder `.htaccess` carries a marked block that redirects that user, so a folder without an offender keeps its file unchanged. Disabling prefixes the hash with `!`, and a new password from Directory Privacy clears it. Refused sign-ins (401) do not count.

Limit: the redirect starts with the next tick, within about a minute, not on the offending request, so the cPanel acceptance wording ("a 4th login ... is redirected") holds for that user's following requests. The window lives in memory; after an agent restart it is rebuilt from the last 4 MiB of the log. The agent truncates `auth.log` once it passes 16 MiB and is fully read.

Proof on Apache 2.4.52 (Ubuntu 22.04, mpm_event, unprivileged, the rendered lines and block): `apache2 -t` passes; the flagged user gets 302 to the configured URL; another user gets 200; a wrong password and a disabled user with the right password get 401; an anonymous request writes no line; every written line parses with `parseAuthLogLine`.
