# The panel serves its own fonts

Date: 2026-11-08. Owner decision.

## Problem

Both themes loaded IBM Plex Sans and Mono from `fonts.googleapis.com` and `fonts.gstatic.com`. Every page view sent the visitor's IP address to a third party, hosts without internet access rendered fallback fonts, and the navigation browser test needed live network access to capture and replay those fonts.

## Decision

- The seven IBM Plex web fonts the themes use ship unmodified in `apps/web/src/vendor/plex/`: Sans 400, 500, 600 and 700, and Mono 400, 500 and 600, from the IBM release tags `@ibm/plex-sans@1.1.0` and `@ibm/plex-mono@1.1.0` (`fonts/complete/woff2`). The SIL Open Font License 1.1 (`LICENSE`) and a notice with the source and the SHA-256 of every file (`NOTICE`) sit beside them.
- The license reserves the name "Plex" for unmodified fonts, so the files are never subset or changed.
- `apps/web/src/vendor/plex.ts` pins each file's SHA-256; a mismatch stops the web process. It serves the files at `/assets/fonts/<file>.woff2` and one stylesheet at `/assets/fonts/plex.css`, with one `@font-face` per weight and `font-display: swap`. URLs carry a content-hash version, and the responses use the existing immutable cache headers for `/assets/`.
- The classic and v2 document heads link that stylesheet and no external origin. Arabic text keeps the generic `sans-serif` family.
- The release ships the font files, the license and the notice as required files.
- Browser tests fail on any request to an external origin, and the navigation test checks that the Plex faces load from the panel origin.

## Not changed

- The panel sent no Content-Security-Policy then. Its later policy ([2026-11-08-content-security-policy.md](2026-11-08-content-security-policy.md)) allows these fonts with `font-src 'self'`.
- The design board fixtures (`apps/web/src/board-port/*.fixture.ts`) mirror the approved artboards and are not served as product pages, so they still name the font service. They are excluded from releases.
