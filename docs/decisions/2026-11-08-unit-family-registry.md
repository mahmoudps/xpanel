# One registry of the systemd units xPanel creates

Date: 2026-11-08.

## Problem

A native upgrade from 0.1.24 to 0.1.37 switched releases and served every site, then settlement refused with `UNKNOWN_CONTROL_PLANE_UNIT_REQUIRES_INSPECTION` and the writer barrier stayed on. The new release's reconcile had created `xpanel-caldav-<user>.service` and `.socket`. The settlement gate in `scripts/lifecycle-services.mjs` kept its own short list of accepted names (control plane, slices, file workers, PHP-FPM, apps, cron services). Every other unit family the agent creates was unknown to it, so any host that used one of them could not finish an upgrade.

## Decision

`packages/core/src/unit-families.ts` is the one list of unit families, each with its exact name grammar: account username, uid (1000 to 65533), short names, PHP version, Web Disk instance, host task id, daemon name, terminal UUID, and the allowed suffixes. It has no imports, so the root lifecycle scripts load it directly and the agent reads it through `@xpanel/core`.

- The gate accepts a loaded `xpanel*` unit only when one family's grammar matches it. A name outside every grammar, such as `xpanel-caldav-Qa1.service`, stays unknown and still needs inspection unless it is not loaded.
- A coordinator (`xpanel-lifecycle.service`, `xpanel-upgrade.service`) is accepted only as the current coordinator, as before.
- Account and host units are observed, never stopped. A control-plane swap, quiescence check, retirement and uninstall stop or require quiet only the four receipt-owned units and the file workers; pending jobs on account units do not block them.
- The `list-units xpanel*` read is bounded like the service manager's (1 MiB, 4096 rows) instead of 64 KiB and 256 rows, because each account adds its slice, PHP-FPM, CalDAV and other units.

`scripts/test-unit-families.test.ts` scans the agent, the shared packages and the root scripts for unit name literals, templates, concatenations and `systemd-run --unit=` values, and fails when one matches no family. It also runs every unit name builder at the grammar bounds. A new unit family is added to the registry in the same change, or the test fails.

The unused `renderRootlessContainerUnit` renderer (`xpanel-container-<user>-<name>.service`) is removed; containers run as `xpanel-ctr-<user>-<name>.service`.
