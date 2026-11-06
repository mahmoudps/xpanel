# API token scopes and PHP-FPM service rows

Date: 2026-11-06. Owner decisions for two small cleanups of existing contracts.

## The `cluster` token scope is removed

xPanel has no cluster membership feature and serves no `/api/cluster/*` route. The `cluster` resource is removed from the accepted token vocabulary, the route policy, the xWHM listener route families and the scope pickers of both themes. Prelaunch cutover: there is no alias or migration.

Token creation refuses `cluster:read` and `cluster:write` like any other unknown scope (`VALIDATION`). A token stored earlier with such a grant keeps working for the grants it also holds and is listed with its scopes exactly as issued. The explicit-grant rule (`hasApiScope`) lets the `cluster` grant authorize nothing, because no route policy assigns that resource; a request to `/api/cluster/*` has no declared policy and is refused.

## PHP-FPM is reported per installed PHP version

Reference: cPanel lists one PHP-FPM service per installed PHP version (`ea-phpXY-php-fpm`) that runs every pool of that version, and restarting it restarts that version only.

Here every account runs its own master, `xpanel-php-fpm-<user>-<version>.service`, inside the account slice, and the distribution master stays off. The services list therefore has one row per installed version, id `php-fpm-<XY>`, label `PHP-FPM X.Y`, with no single unit:

- A version is installed when its distribution FPM unit file exists (Ubuntu `phpX.Y-fpm.service`, EL Remi `phpXY-php-fpm.service`) or an account master for it exists.
- Counted masters are loaded and enabled or running. A suspended account's master is stopped and disabled and is not counted.
- `fpm` carries `version`, `masters`, `running` and `failed`; the rest are stopped. The row state is `active` when every counted master runs, `failed` when any failed, otherwise `inactive`. The page shows the counts (running, partly failed, failed, stopped).
- A version without accounts shows 0 masters and offers no restart; the agent refuses it with `PRECONDITION_FAILED` (`no_account_masters`).
- An unreadable unit inventory gives one `php-fpm` row `unchecked`; no installed version gives one `php-fpm` row `not-installed`.

Restart of `php-fpm-<XY>` uses the existing config-test-first path: each counted master's own `php-fpm --test` runs as the account, and the restarts start only after every test passed. It restarts exactly those masters and never the distribution master.

Cost: a services read adds one `systemctl list-units` and one `systemctl list-unit-files` call to the per-unit `show` calls. The existing service-manager parser bounds that output (1 MiB, 4096 rows); an inventory over the bound reports `unchecked` instead of a guess.
