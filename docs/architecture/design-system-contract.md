# Unified Design System & Action Architecture Contract

**Status:** Approved Phase 0 Engineering Contract
**Applies to:** `xWHM`, `xPanel`, `xMail`, authentication, status, and unavailable surfaces
**Prelaunch Naming Rule:** Zero version suffixes (`v0`-`v9`) and zero marketing adjectives (`smart`, `legacy`, `hero`, `magic`, `super`) in new directories, filenames, exports, classes, tokens, or attributes (`apps/web/src/design-system/`, `apps/web/src/data/`, `apps/web/src/features/`). The root DOM theme selector `[data-ui-theme="v2"]` remains intact as the stable runtime hook.

---

## 1. Purpose and Authority

Every screen in xPanel, xWHM, and xMail is governed by one design-token file, one 30-component UI library, one formatting library, one client data/cache store, one live on-demand action engine, and 16 automated QA gates (`G1` through `G16`).

No page may bypass the token scale, embed inline `style=` attributes, write raw hex colors outside `tokens.json`, use `!important`, invent ad-hoc date/byte/number formatting, expose internal platform jargon (`reconciler`, `generation`, `desired state`, `qualification`, raw daemon unit names as primary titles), or render unassisted `"Not read"` / `"Not observed"` placeholders in normal operation.

---

## 2. Single-Source Design Tokens (`apps/web/src/design-system/tokens.json`)

All CSS custom properties (`styles/tokens.css`) and TypeScript token constants (`tokens.ts`) are generated strictly from `apps/web/src/design-system/tokens.json` via `node scripts/generate-design-tokens.mjs --write` and verified in CI via `--check`.

### 2.1 Spacing Scale (8-Step Scale Only)

Allowed spacing values (in `px`): `4, 8, 12, 16, 24, 32, 48, 64`.
- Stack rhythm inside forms & compact groups: `8px` (`--ds-space-8`) label-to-control, `16px` (`--ds-space-16`) sibling fields & action controls, `24px` (`--ds-space-24`) card padding (desktop) / sibling content groups / field-group-to-actions, `32px` (`--ds-space-32`) major section gaps.
- Phone (`<= 600px` / container mobile): card padding tightens to `16px` (`--ds-space-16`).
- All spacing rules use CSS logical properties (`margin-block`, `padding-inline`, `inset-inline-start`) — never physical `left`/`right`.

### 2.2 Corner Radii (3-Step Scale Only)

| Role | Token | Value | Replaces |
|---|---|---|---|
| Controls, inputs, buttons, chips, tags | `--radius-control`, `--radius-chip` | `8px` | `7px`, `9px`, `14px` |
| Cards, notices, dialogs, drawers, code blocks | `--radius-card`, `--radius-notice` | `12px` | `10px`, `14px` |
| Status badges, account pills | `--radius-pill` | `999px` | — |

### 2.3 Typography Scale (7-Step Scale Only)

Allowed font sizes (in `px`): `12, 13, 14, 16, 20, 26, 32`.

| Role | Size / Weight | EN Line-Height | AR Line-Height | Explicitly Defined Scope |
|---|---|---|---|---|
| Table headers, compact badges, micro-labels | `12px` / `600` | `18px` | `20px` | Dense tables, status pills, keyboard hints |
| Captions, helper text, secondary timestamps | `13px` / `400` | `20px` | `22px` | Form help, muted metadata |
| Admin body, table cells, inputs, buttons, nav | `14px` / `400`–`600` | `22px` | `24px` | Standard density across management tables, forms, nav |
| Prose & narrative copy, mobile inputs | `16px` / `400` | `24px` (`1.5`) | `26px` (`1.65`) | Paragraphs, descriptions, empty/error copy, mobile input prevention of auto-zoom |
| Card titles & major section headings (`h2`) | `20px` / `600` | `26px` (`1.25`) | `28px` (`1.35`) | Section and card headings |
| Page titles (`h1`) | `26px` / `700` | `34px` | `36px` | Primary page heading in sticky header |
| Primary KPI metrics & auth code display | `32px` / `700` | `38px` | `40px` | Stat strip figures & status codes |

**Explicit Administration Density Rule:** Administrative tables, form labels, controls, and sidebar navigation default to `14px` (`22px` EN / `24px` AR) for clarity and density, while narrative descriptions, banners, and mobile touch inputs use `16px` (`24px` EN / `26px` AR).

**Font Stacks:**
- English UI: `'IBM Plex Sans', 'IBM Plex Sans Arabic', system-ui, sans-serif`
- Arabic UI (`:lang(ar)` / `[lang="ar"]`): `'IBM Plex Sans Arabic', 'IBM Plex Sans', system-ui, sans-serif`
- Code & technical values: `'IBM Plex Mono', 'IBM Plex Sans Arabic', ui-monospace, Consolas, 'Liberation Mono', sans-serif` (ends in `sans-serif`, never generic `monospace`, ensuring connected Arabic glyph shaping inside mixed code/log lines).
- Numerals: Western ASCII digits (`0-9`) with `font-variant-numeric: tabular-nums` across all metrics, dates, counts, and tables.

### 2.4 Semantic Color Palette (`<= 35` Semantic Color Roles)

Both Light and Dark themes derive from the exact same semantic variable names (dark mode never invents a parallel vocabulary):
- **Surfaces (4):** `--bg` (canvas), `--surface` (card/topbar), `--subtle` (elevated/hover fill), `--sunken` (well/disabled fill).
- **Text (3):** `--text` (primary), `--text-2` (secondary), `--muted` (captions/meta).
- **Borders & Focus (3):** `--line` (card/table separator), `--line-strong` (input/focus border), `--focus` (focus ring `#1D5BD6` light / `#84A9FA` dark, `2px` solid + `2px` offset).
- **Accent (6):** `--accent`, `--accent-fill`, `--accent-fill-hover`, `--accent-soft`, `--accent-line`, `--on-accent`.
- **Semantic Statuses — 3 grades each (`text`, `soft`, `line`) = 12:**
  - Success: `--ok`, `--ok-soft`, `--ok-line`
  - Warning: `--warn`, `--warn-soft`, `--warn-line`
  - Danger: `--bad`, `--bad-soft`, `--bad-line`
  - Info: `--info`, `--info-soft`, `--info-line`
- **Code & Charts (4):** `--code`, `--code-text`, `--code-muted`, `--chart-2`.
- **Navigation Surface Overrides (in Light Mode):**
  - `xWHM` (`[data-surface="xwhm"]`): Navy administration sidebar (`--nav: #0A1830`, `--nav-2: #14284B`, `--nav-line: #1E3660`, `--nav-text: #C5D0E2`, `--nav-muted: #8796AE`, `--nav-strong: #FFFFFF`, `--nav-accent: #5B8DF6`, `--nav-focus: #84A9FA`).
  - `xPanel` & `xMail` (`[data-surface="xpanel"]`, `[data-surface="xmail"]` in light mode): White crisp sidebar (`--nav: #FFFFFF`, `--nav-2: #F6F8FB`, `--nav-line: #DCE3EE`, `--nav-text: #334155`, `--nav-muted: #586579`, `--nav-strong: #0D1626`, `--nav-accent: #1D5BD6`, `--nav-focus: #1D5BD6`), restoring the owner artboard distinction between server administration (`xWHM`) and tenant workspace (`xPanel`/`xMail`).
  - Dark mode (`[data-theme="dark"]`): Unified deep navy rail & surfaces across all portals (`--nav: #060C17`, `--bg: #080F1C`, `--surface: #101A2C`, `--subtle: #142138`).

### 2.5 Motion, Scroll, Grid & Fixed Page Anatomy

- **Durations:** `--dur-press: 120ms` (press feedback), `--dur-menu: 160ms` (menus/dropdowns/popovers), `--dur-overlay: 200ms` (drawers/dialogs). Hover color swaps remain instant unless noted for overlay geometry.
- **Easing:** `--ease-out: cubic-bezier(0.2, 0.8, 0.2, 1)`.
- **Reduced Motion:** `@media (prefers-reduced-motion: reduce)` sets motion duration tokens to `0ms` and disables smooth scrolling without using `!important`.
- **Layout & Chrome:**
  - `12`-column CSS grid with `24px` gutter (`16px` mobile).
  - Main content container capped at `1280px` max width.
  - Desktop sidebar `264px` expanded, collapsible to `72px` (`[data-sidebar-collapsed="true"]`) with user preference persisted in UI settings.
  - Desktop sticky topbar `64px`; desktop first-screen density guarantees primary table headers appear at `y <= 290px` (first row `<= 340px`) and dashboard/wizard primary workspace starts at `y <= 260px` (`1440x900`).
  - **Single Scroll Container:** Page scrolls vertically on the document only (`html { scroll-behavior: smooth; scroll-padding-block-start: 80px; }`); nested horizontal scrolling is confined solely to wide table wrappers when strictly needed on desktop/tablet, never clipped text.
  - **Fixed Page Order:**
    1. Sticky Page Header: Concise title (`h1`, matching sidebar item and breadcrumb leaf identically) + single-line description + status badge + **1 primary CTA** + secondary actions collapsed into an `ActionMenu` (NO raw URL route string displayed inside the header).
    2. Summary Stat Strip: `3` to `4` concise KPI cards/metrics.
    3. Primary Workspace: Focused table (`<= 25` rows/page with pagination) OR guided drawer/wizard/editor.
    4. Secondary Context: Tabs or collapsible disclosures (`<details>`) so pages stay `<= 4` viewports tall without tabs.

---

## 3. Canonical Component Library (30 Components) & Formatters

All components reside under `apps/web/src/design-system/components/` with stylesheets in `apps/web/src/design-system/styles/*.css`:
- **Layout (6):** `AppShell`, `PageHeader`, `StatStrip`, `Card`, `Section`, `Tabs`.
- **Data (10):** `DataTable` (sort, filter, `<= 25` row pagination, bulk selection, row `ActionMenu`, responsive card layout on mobile), `KeyValue`, `Metric`, `Sparkline`, `StatusBadge`, `EmptyState`, `ErrorState`, `Skeleton` (dimension-locked to avoid `CLS >= 0.05`), `LiveReadState`, `Pagination`.
- **Actions (7):** `Button`, `SplitButton`, `ActionMenu`, `ConfirmDialog`, `Drawer`, `Toast` (supports inline `Undo` callback), `Wizard` (displays one active step at a time, live preflight, dry-run change plan, WebSocket execution stream, completion receipt).
- **Inputs (8):** `Field`, `Input`, `Select`, `Combobox`, `Switch`, `RadioCard`, `CodeInput`, `CronBuilder` (preset + frequency controls with human-readable schedule summary in English and Arabic; raw cron syntax stays behind an optional toggle).
- **Auth / Touch Rule:** Primary login/challenge inputs remain `>= 48px` tall on auth screens; every interactive control meets `>= 44x44px` effective hit target on mobile (`G11`).

**Canonical Formatters (`apps/web/src/design-system/formatters.ts`):**
Pages never hand-format bytes, durations, timestamps, counts, or technical identifiers:
- `formatBytes(bytes, locale)`: Single IEC unit (`B`, `KiB`, `MiB`, `GiB`, `TiB`), 2 decimal places (`10.00 GiB`, `0.09 MiB` or `92.00 KiB`), ASCII `0-9`.
- `formatRate(bytesPerSec, locale)`: Single IEC `/s` rate.
- `formatDuration(seconds, locale)`: Human-readable units everywhere (`13d 23h` / `13 يوم 23 ساعة`) — never raw `"522233 seconds"`.
- `formatDateTime(input, { locale, timeZone, showUtc })`: Renders in the user's configured or detected timezone (with optional UTC note where audit precision requires), wrapped in `<bdi dir="ltr">` with ASCII `0-9`.
- `formatNumber(value, locale, options)` & `formatPercent(value, locale, decimals)`: Thousands separators always enabled (`99,311`, `9,732,496`), ASCII `0-9`.
- `isolateTechnical(value)`: Wraps IPs, domains, paths, emails, usernames, systemd units, and dates in `<bdi dir="ltr">` with HTML escaping.

---

## 4. Live On-Demand Data & 8-Step Action Lifecycle

### 4.1 On-Demand Data Layer (`apps/web/src/data/` + Server Telemetry & Readers)

- **Single Authoritative Telemetry Service:** Every dashboard, accounts table, monitoring view, support bundle, upgrade panel, and database page reads host OS, CPU, memory, disk, inodes, uptime, and account usage from one authoritative server service so values match across `xWHM` and `xPanel` within the same TTL window.
- **No Unassisted `"Not read"` / `"Not observed"`:** Data fetches automatically on view open and caches via `apps/web/src/data/` (`<= 1` `/api/auth/me` request per full page load, shared session/preferences/notifications/favorites store, focus + WebSocket revalidation). When a datum cannot yet be shown, `LiveReadState` displays exactly one of:
  1. **Loading:** Dimension-locked skeleton + `"Loading..."` (`جاري القراءة...`).
  2. **Error with Retry:** Clear failure reason + `Retry` (`أعد المحاولة`) button triggering an on-demand read endpoint.
  3. **Disabled Service with Enable Link:** Explicit explanation + direct button/link to enable or configure the service.
  Plus `lastReadAt` timestamp (`formatDateTime`) and a working `Refresh` control.
- **Command Palette (`Ctrl+K` / `Cmd+K`):** Executes actions directly (create account, open firewall port, issue certificate, suspend/resume, restart service, navigate to page) rather than acting solely as static link navigation.

### 4.2 8-Step Action Lifecycle & 12 Priority-1 Guided Wizards

Every mutating action (whether in a `<= 5`-field `Drawer` or a multi-step `Wizard`) follows this deterministic lifecycle:
1. **Intent:** Triggered from page header CTA, table row `ActionMenu`, or executable `Ctrl+K`.
2. **Scoped Input Container:** `<= 5` fields open in a `Drawer`; `> 5` fields or multi-domain/risk operations open in a `Wizard` showing **only one step at a time**.
3. **Live Preflight (`300ms` debounce):** Availability checks (username, domain, quota/capacity, IPv4/port/DNS readiness, mailbox conflicts, PHP compatibility) validate against `/api/.../preflight` with inline pass/fail feedback — eliminating `"Checked when submitted"`.
4. **Dry-Run Change Plan Preview:** Shows `"What will change"` (files, services, accounts, before/after limits, estimated duration, reversibility / rollback availability) before submission.
5. **Confirmed Execution -> Job Creation:** Submitting dispatches `POST` execution, creates a tracked host `Job`, and opens live execution tracking.
6. **Live WebSocket Progress:** Step statuses stream (`pending -> running -> done | failed`) with concise log output; users may leave to the Jobs drawer/page and resume without losing state.
7. **Completion Receipt:** Structured summary, direct link to the created/updated resource, and an actionable `Undo` toast when reversible.
8. **Error & Rollback Honesty:** Failed preflight or job steps return explicit remediation messages without fabricating success.

**Twelve Priority-1 Guided Wizards:**
1. Create account (`/whm/accounts/new`)
2. Suspend / unsuspend / terminate account
3. Transfer / migrate account
4. Issue or install TLS certificate (`/security/ssl/issue` & `/whm/tls`)
5. Add domain with DNS & mail records (`/domains`)
6. Create mailbox with SPF + DKIM (`/email/accounts` & `/whm/email`)
7. Restore backup archive (`/whm/backups/restore` & `/files/backup`)
8. Schedule backups (`/whm/backups` using `CronBuilder`)
9. Switch PHP version & extensions (`/software/php` & `/whm/software/php`)
10. Control plane release upgrade (`/whm/server/upgrade`)
11. Open/manage firewall port (`/whm/security/firewall`)
12. Initial server setup wizard (`/whm/setup` / first-run)

---

## 5. Information Architecture (IA) & Surface Disposition

- **Uniform Naming (`G2`):** For every page in all portals, Sidebar Item Label = Header `h1` = Breadcrumb Final Segment = `Ctrl+K` Search Label.
- **Zero Developer Jargon in User Copy:** Primary page headings, descriptions, and empty/status summaries never surface internal engineering terms (`reconciler`, `generation`, `desired state`, `qualification`, raw systemd socket/slice names) outside explicit advanced technical inspect views (`<details>`).
- **12 Task-Oriented `xWHM` Sections:**
  1. Home (Server status, items needing attention, active jobs, quick KPIs & actions)
  2. Accounts (Accounts, Create account, Account health, Bandwidth, Announcements, Templates)
  3. Sites & Domains (Zones, DNS tools, TLS/SSL, Redirects, Site health)
  4. Mail (Mail server, Queue, Domains, Spam & routing, Forwarders)
  5. Databases (MySQL/MariaDB, PostgreSQL, MongoDB, Redis, phpMyAdmin, Users, Database server settings)
  6. Software (Site software, PHP versions & handlers, Runtimes, Modules, Containers)
  7. Services (Service overview & service manager — folding `/whm/services/more` as tabs/subpages while keeping URL aliases)
  8. Security (Firewall, SSH & console, 2FA & passwords, Security center, Brute-force/ModSecurity — folding security extras cleanly)
  9. Backups & Transfers (Scheduled backups, Destinations, Restore, File/account transfers — folding `/whm/backups/restore-more`)
  10. Monitoring & Logs (Processes, Disk & benchmark, Web stats, Audit log, Raw metrics)
  11. System (Server setup, Networking, Terminal, OS & kernel, Upgrade)
  12. Integrations & Settings (API tokens, Notifications, Preferences, License/Support)
- **Written Catalog Disposition Policy (`xWHM` Unlisted Entries):**
  During Phase 2 (Milestone B), all unverified/catalog-only routes (`spam-quarantine`, `reverse-proxy`, `cloudflare`, `app-installer`, `cloudflare-dns-providers`, `dns-cluster`, `server-migration`, `database-tuning`, `application-deployments`, `server-nodes`, plus `antivirus` and `intrusion-detection`) must each receive an explicit written disposition in the navigation & feature matrix: either wired to a live capability module and exposed in sidebar navigation (`G1` = 0 orphans), OR cleanly removed from active navigation/catalog until the host capability ships. No catalog route may exist silently in limbo.
- **`xPanel` & `xMail` Homes:**
  - `xPanel` home highlights **My Sites** and 1-click quick actions (Add domain, Create mailbox, Issue TLS, Create database, Create backup), followed by account usage & urgent alerts.
  - `xMail` retains its classic 3-pane mail workbench (Folders, Message List, Message Reader/Composer) built entirely from unified `design-system` components and tokens.

---

## 6. Automated Design QA Gates (`G1`–`G16`)

No PR merges without passing all applicable static and browser gates in `scripts/design-qa-gates.mjs`:

| Gate | Requirement | Verification |
|---|---|---|
| `G1` | Zero orphans; 100% parity between navigation catalog and served sidebar routes (including explicit dispositions) | Static & Browser |
| `G2` | Sidebar label == Page `h1` == Breadcrumb leaf == Search title | Static & Browser |
| `G3` | Page anatomy: `h1`, single-line subtitle, status badge, 1 primary CTA, action menu, stat strip, no raw route string | Browser & Static |
| `G4` | Zero `"Not read"` / `"Not observed"` in normal states; loading/error/enable states + timestamp + Refresh button | Static & Browser |
| `G5` | 100% numbers, bytes (`IEC`), durations (`Xd Xh`), and user-timezone dates formatted through unified formatters | Static & Browser |
| `G6` | 100% computed styles from `tokens.json`; 0 raw hex outside `tokens.json`; 0 `!important`; 0 inline `style=` | Static & Browser |
| `G7` | Tables `<= 25` rows/page; page height `<= 4` viewports unless tabbed | Browser |
| `G8` | Logical CSS only; `<bdi dir="ltr">` on dates/IPs/domains/paths; mirrored EN/AR arrows; 0 untranslated English on AR pages | Static & Browser |
| `G9` | All timestamps rendered in user timezone (UTC secondary only) | Browser |
| `G10` | Every component/widget handles loading, empty+action, error+retry, and forbidden/disabled states | Unit & Browser |
| `G11` | Mobile (`390x844`) zero touch targets `< 44px`; zero horizontal overflow or clipped essential text | Browser |
| `G12` | Zero `axe-core` WCAG 2.1/2.2 AA violations (including `/whm/server/upgrade`) | Browser |
| `G13` | Zero duplicate `id`s, zero unlabeled inputs, strictly hierarchical headings | Browser |
| `G14` | Page settles `< 1.5s`; `<= 1` `/api/auth/me` call per load; zero console/page errors | Browser |
| `G15` | Transitions use `120`–`200ms` tokens + `standard ease-out`; respects `prefers-reduced-motion`; `CLS < 0.05` | Browser |
| `G16` | Visual pixel diff `< 0.1%` against approved baseline screenshots across all 8 modes (`en/ar x light/dark x desktop/mobile`) | Browser (local/release baselines in `D:/xpanel-design-baselines/`) |
