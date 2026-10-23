# Using the shell

New pages should look like the existing ones without a private stylesheet. Render them through the shared shell and the classes in `apps/web/src/tokens.ts`. The token values and the reasons for the 44px targets and 26px page title are in [artifact-design-system.md](artifact-design-system.md).

## Page shape

1. Pick the surface (`xpanel`, `xwhm`, or `xmail`) and add the route to the surface section map in `apps/web/src/shell.ts` only when the screen is actually implemented.
2. Return `renderSurfaceShell` with the surface sidebar, top bar, and one main region.
3. Give the screen a single `h1.xp-page-title`. Put supporting text in `p.xp-prose`.
4. Wrap the body in `section.xp-card`. Use `xp-table` for records, `xp-field` / `xp-label` / `xp-input` for forms, and `xp-btn` / `xp-btn--primary` for actions.
5. Show state with `renderStatusBadge`. Put identifiers, addresses, and timestamps in `bdi dir="ltr"`, and format dates and sizes with `formatAsciiDate` and `formatAsciiBytes`.
6. Confirm a destructive action with `<dialog class="xp-dialog">`. Do not use `window.prompt` or `window.confirm`.
7. Write every visible string in both catalogs in `apps/web/src/i18n.ts`, or as an explicit English/Arabic pair next to the markup. Arabic layout uses logical CSS (`padding-inline`, `margin-inline`, `inset-inline`) so the shell mirrors without a second template.

## What stays shared

The sidebar width, brand mark, navigation item, disabled tool row, top bar, user pill, focus ring, dialog, badge, and toast already live in the design tokens. A new page inherits them by using the classes. Adding a one-off colour or a fixed left/right inset will drift from the artboard and from Arabic.

Motion values are recorded in the Motion section of [artifact-design-system.md](artifact-design-system.md). Do not add a duration, easing curve, or spring the artboard does not declare. Hover and focus on the artboard are immediate. `prefers-reduced-motion: reduce` removes animation and transition.

Unavailable catalog groups stay on `renderPlannedNavigation`. They use the dashed disabled row and must not become links.

## Checking the result

`tests/browser/artifact-visual.mjs` writes screenshots for the current pages in English and Arabic, light and dark, desktop and mobile. It is not part of `pnpm test`. From the repository root, with the pinned toolchain:

```sh
node scripts/toolchain.mjs node tests/browser/artifact-visual.mjs
```

Set `XPANEL_VISUAL_OUTPUT` to choose the directory. The default is `test-results/artifact-visual`.
