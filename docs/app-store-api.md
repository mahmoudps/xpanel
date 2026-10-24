# App store and installer API

This file is the contract for the original signed application catalog and the account installer. No route in this contract is implemented. Clients must not treat a rendered store screen, an empty list, or a disabled control as a completed install, update, rollback, or uninstall.

Domain purchase, vendor licence storefronts, and third-party commercial installers are not part of this contract.

## Authentication

Account routes require the signed-in account session and apply only to that account. Root routes require a root session. State-changing requests send the panel CSRF token. A missing session is unauthorized. A session for the wrong account is forbidden.

Until the installer and a signed catalog exist, every state-changing route responds `501` with:

```json
{ "error": "installer_unavailable" }
```

That response is not a success. Reads that have no record respond `200` with an empty list or `null` fields. They do not invent applications, versions, permissions, logs, or percents.

## Account routes

| Method | Path | Body | Result |
|---|---|---|---|
| `GET` | `/api/xpanel/store/catalog` | — | Applications visible to this account. |
| `GET` | `/api/xpanel/store/catalog/:appId` | — | One application, or `404`. |
| `GET` | `/api/xpanel/store/installed` | — | Installations on this account. |
| `POST` | `/api/xpanel/store/install` | Install request | `202` and a job, or `501`. |
| `POST` | `/api/xpanel/store/jobs/:jobId/cancel` | — | `202`, or `501`. |
| `GET` | `/api/xpanel/store/jobs/:jobId` | — | Last job snapshot, or `404`. |
| `GET` | `/api/xpanel/store/jobs/:jobId/events` | — | Server-sent events for that job. |
| `POST` | `/api/xpanel/store/installations/:installationId/uninstall` | `{ "confirm": true }` | `202` and a job, or `501`. |
| `POST` | `/api/xpanel/store/updates` | `{ "installationIds": ["..."] }` | `202` and one job per installation, or `501`. |
| `POST` | `/api/xpanel/store/installations/:installationId/rollback` | — | `202` and a job, or `501`. |

Install request:

```json
{
  "appId": "string",
  "version": "string",
  "domain": "string",
  "path": "string",
  "createDatabase": false,
  "adminUser": "string",
  "adminEmail": "string",
  "consent": false
}
```

`consent` must be `true` and must name the permission set returned with the application. A request with `consent: false` is `422`. The admin password is not a JSON field; it is collected on a separate authenticated channel and is never written into the job event stream or the audit log.

Catalog application:

```json
{
  "id": "string",
  "name": "string",
  "version": "string",
  "summary": "string",
  "description": "string",
  "categories": ["string"],
  "featured": false,
  "screenshots": [{ "url": "string", "alt": "string" }],
  "requirements": ["string"],
  "permissions": [{ "id": "string", "label": "string" }],
  "changelog": [{ "version": "string", "notes": "string" }],
  "signature": { "keyId": "string", "algorithm": "string" }
}
```

Installation:

```json
{
  "id": "string",
  "appId": "string",
  "version": "string",
  "previousVersion": null,
  "domain": "string",
  "path": "string",
  "updateAvailable": null,
  "autoUpdate": null,
  "backupBeforeUpdate": null,
  "openUrl": null,
  "adminUrl": null
}
```

`updateAvailable`, `autoUpdate`, `backupBeforeUpdate`, `openUrl`, and `adminUrl` stay `null` when they were not read. Clients show “not read”, not a false or a zero.

## Root routes

| Method | Path | Body | Result |
|---|---|---|---|
| `GET` | `/api/whm/store/sources` | — | Catalog sources. |
| `POST` | `/api/whm/store/sources` | `{ "url": "string" }` | `202` after the signature verifies, or `501`. |
| `GET` | `/api/whm/store/trust` | — | Trusted signing keys. |
| `GET` | `/api/whm/store/apps` | — | Catalog applications and whether each is enabled. |
| `POST` | `/api/whm/store/apps/:appId/enabled` | `{ "enabled": true }` | `202`, or `501`. |
| `GET` | `/api/whm/store/plans/:planId/features` | — | Feature keys for that plan. Missing keys are omitted, not stored as empty strings. |
| `PUT` | `/api/whm/store/plans/:planId/features` | `{ "keys": { "appId": "feature-key" } }` | `202`, or `501`. |
| `GET` | `/api/whm/store/extensions` | — | Root extensions. |
| `POST` | `/api/whm/store/extensions/install` | `{ "extensionId": "string", "consent": false }` | `202` and a job, or `501`. |
| `POST` | `/api/whm/store/extensions/:extensionId/update` | — | `202` and a job, or `501`. |
| `POST` | `/api/whm/store/extensions/:extensionId/rollback` | — | `202` and a job, or `501`. |
| `GET` | `/api/whm/store/activity` | — | Installer audit events. |

A source is stored only after its catalog document matches a trusted key. The trust view returns key id, algorithm, and fingerprint. It does not return private key material.

## Progress events

`GET /api/xpanel/store/jobs/:jobId/events` is a Server-Sent Events stream. Each event uses the name `progress` and a JSON `data` line. The same JSON object is one text frame on a WebSocket at `/api/xpanel/store/jobs/:jobId/stream`.

```json
{
  "jobId": "string",
  "installationId": null,
  "appId": "string",
  "phase": "catalog",
  "status": "queued",
  "progress": { "kind": "idle" },
  "step": { "id": "catalog", "state": "pending" },
  "log": null,
  "error": null
}
```

`phase` is `catalog`, `requirements`, `target`, `database`, `files`, `record`, `update`, or `rollback`.

`status` is `queued`, `running`, `succeeded`, `failed`, or `cancelled`.

`progress` is one of:

```json
{ "kind": "idle" }
{ "kind": "indeterminate" }
{ "kind": "determinate", "percent": 0 }
```

`percent` is an integer from 0 through 100 and is present only when `kind` is `determinate`. Clients do not draw `0%` for `idle` or `indeterminate`. A determinate bar transitions to the new percent. An indeterminate bar may shimmer. Reduced motion disables that transition and that shimmer.

`step.state` is `pending`, `current`, `done`, `failed`, or `skipped`.

`log`, when present, is `{ "seq": 1, "at": "2026-01-01T00:00:00Z", "level": "info", "message": "string" }`. `level` is `info`, `warn`, or `error`. `seq` increases by one within the job.

`error`, when `status` is `failed`, is `{ "code": "string", "message": "string" }`. Other statuses send `error: null`.

A `succeeded` event is the only success signal. A disconnected stream is not a success and not a failure. The client keeps the last snapshot and offers retry only after `failed` or `cancelled`.
