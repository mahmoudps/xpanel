# Site settings, 2026-11-07

The Site settings page saves its settings through `PUT /api/domains/:id/site-settings`. `POST /api/domains/bulk-actions` applies one action to several sites for root. Both go through the domain workspace path, so each change passes the configuration test before any reload.

## Where the settings live

Settings beyond the site type sit in `domain.site`, in the domain's state file, and only when they differ from the default. An unconfigured site renders as before. The field is part of the workspace revision and moves with an account transfer.

Nginx fronts every engine, so deny rules, traffic limits, the visitor log switch and the stopped message render at the edge and hold for Apache and OpenLiteSpeed alike. The backends read the run directory by rendering with the served directory as the document root. The document root stays the project root for Composer, staging and backups. `.htaccess` tools, Directory Privacy URLs and the Site Publisher follow the served directory.

## Decisions

- **Every save reaches the test.** A setting with no directive of its own, such as an expiry date in the future or a category, would render the same file, and an unchanged generation is reported as not applied. A hash of these settings sits in a comment in the site's nginx file, so each save applies. The hash avoids putting the reminder address in a world-readable file.
- **A failed test rolls the save back.** A failed generation leaves the previous configuration running; the route restores the domain so no later apply repeats the failure.
- **Owner stop.** The owner may lift only a stop the owner made (`site.stoppedByOwner`). A stop by root is refused with `stopped_by_administrator`. A root bulk stop clears the mark.
- **Isolation uses `php_value`.** `php_admin_value[open_basedir]` locks the value, and PHP then ignores `.user.ini`. A pool with an isolated site renders `php_value[open_basedir]`. PHP allows only narrowing, so the tenant cannot widen it. Other pools stay as they were. `site-options.host.test.ts` proves both on real php-fpm. OpenLiteSpeed sets the value as a locked admin value, so isolation refuses there with `isolation_engine`. Isolation separates sites of one account; that account can change its own `.user.ini`.
- **Visitor log switch.** nginx keeps writing a `xpanel_usage` line with the visitor fields blank, because bandwidth limits read this log. Every log reader parses the line unchanged.
- **Path quota.** XFS project quota only, as the tool specifies. Anything else refuses with `QUOTA_UNSUPPORTED_FS`. Project ids are hashed from the domain id. Setting a project walks the whole tree, so the action runs only when the quota or the document root changed since the applied generation. A host that cannot enforce a quota saved earlier, such as one moved to ext4, keeps serving and the page says so.
- **Expiry.** The agent checks every 5 minutes and asks for one reconcile when a date passes, because no state changes at that moment. A ledger in `extended/site-expiry.json` keeps a restart from repeating a reconcile or a reminder.
- **Traffic limits.** Each limited site holds two 1 MB shared zones. A site without limits holds none, so the memory budget is unchanged. Trusted WAF addresses stay exempt.
- **Bulk delete** refuses a site with child domains or service users, and keeps the files in the account home. The catalog text says files go to the recycle bin; xPanel keeps them in place on any domain removal, so there is nothing to recover.
- **Page scope.** Names, redirects, proxy, logs, folder protection, IP blocker and hotlink protection link to their working pages instead of repeating their controls.
