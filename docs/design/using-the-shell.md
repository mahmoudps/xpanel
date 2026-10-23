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

Motion values are recorded in the Motion section of [artifact-design-system.md](artifact-design-system.md). Premium components binds them, and every screen uses that library: spinner `animation: xp-spin 0.9s linear infinite`, progress and quota fills `transition: width 0.6s ease`, indeterminate bar `animation: xp-indet 1.4s ease-in-out infinite`, skeleton `animation: xp-shimmer 1.4s linear infinite`, undo drain `animation: xp-drain 8s linear infinite`. Use `xp-status-icon--spin`, `xp-meter__fill`, `xp-meter__indet`, `xp-skeleton`, and `xp-toast__drain` rather than a new duration. Link hover and focus are immediate. Disabled, pressed, error, empty, and loading states are the colours written in that same note. `prefers-reduced-motion: reduce` removes animation and transition.

Design-complete screens from the artifact boards are real routes. The sidebar lists them in the board’s groups. A page whose tool is not connected yet renders `renderDesignMain` from `apps/web/src/design-board.ts`: the board’s title, its section cards, the board’s empty state, and disabled actions with `قيد التفعيل` / Coming soon. Its records come from the named adapter next to that route (`readPanelPhpPage`, `readSshPage`, and the others). Wiring the tool means filling that one function. Do not invent rows in the page. Home in Arabic and on a narrow viewport is the same `/home` route.

## Checking the result

`tests/browser/artifact-visual.mjs` writes screenshots for the current pages in English and Arabic, light and dark, desktop and mobile. It is not part of `pnpm test`. From the repository root, with the pinned toolchain:

```sh
node scripts/toolchain.mjs node tests/browser/artifact-visual.mjs
```

Set `XPANEL_VISUAL_OUTPUT` to choose the directory. The default is `test-results/artifact-visual`.
