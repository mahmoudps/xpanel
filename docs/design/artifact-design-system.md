# Artifact design system

This note records the visual system used by the dedicated xPanel, xWHM, and xMail screens, restated as tokens the product can implement. The source artboards are light. The dark theme below is derived from the same navy ink used by the administration rail and code blocks, so dark mode stays in the family instead of introducing a second palette.

Product accessibility rules still win where they are stricter than the artboard. Hit targets stay 44px, and the page title stays 26px / 34px (Arabic 36px). The artboard used 40px navigation rows and a 22px page title. Those two sizes are the accessibility polish on top of the artboard, not a second design.

## Colour

Light surfaces:

| Role | Value |
|---|---|
| Canvas | `#f5f6f8` |
| Surface | `#ffffff` |
| Elevated / field fill | `#f8f9fb` |
| Text | `#101828` |
| Secondary text | `#344054` |
| Muted text | `#5d6b7e` |
| Accent | `#1d5bd6` |
| Accent hover | `#1546a8` |
| Accent soft | `#e8effd` |
| Accent border | `#c7d7f8` |
| Border | `#e2e6ec` |
| Strong border / input | `#d0d5dd` |
| Focus | `2px solid #1d5bd6`, offset `2px` |
| Code background | `#0e1726` |
| Code text | `#e6edf7` |

Status chips:

| State | Text | Fill | Border |
|---|---|---|---|
| Healthy | `#0e7a4e` | `#e7f5ee` | `#a9dfc8` |
| Warning | `#9a3b06` | `#fef0e6` | `#f7c697` |
| Critical | `#b42318` | `#fdecea` | `#f5b7b1` |
| Neutral chip | `#344054` | `#eef1f6` | `#d0d5dd` |

Progress tracks use `#e9ecf1`. Avatar and icon tiles use `#e8effd` with border `#c7d7f8`.

Dark theme, derived from the navy rail:

| Role | Value |
|---|---|
| Canvas | `#0e1726` |
| Surface | `#152033` |
| Elevated | `#1d2b40` |
| Text | `#e6edf7` |
| Secondary text | `#c9d3e1` |
| Muted text | `#8a99af` |
| Accent / focus | `#6ea0ff` |
| Borders | `#2a3a52` / `#3a4d6b` |

xPanel and xMail sidebars are white (`#ffffff`), 248px wide, with 20px by 14px padding. The xWHM sidebar is navy `#0e1726`. Its group labels are 11px, weight 600, colour `#8a99af`. The active xWHM item is `#1d2b40` with white text, weight 600, and a 3px accent bar (`#6ea0ff`) on the inline-start edge. In Arabic that bar uses a negative inset so it stays on the reading-start side.

## Type

- UI: IBM Plex Sans, with IBM Plex Sans Arabic first when `dir=rtl`.
- Identifiers, the brand word, and code: IBM Plex Mono.
- Scale used in the product: caption 13/20 (Arabic 22), label 14/22 (Arabic 24), body 16/24 (Arabic 26), card 18/28 (Arabic 30), page 26/34 (Arabic 36).
- Labels are weight 600. Navigation labels are 14px, weight 500, and 600 when active.
- Numerals stay Western ASCII and tabular.

The brand mark is a 36px square, radius 8, background `#101828`, with a mono “x”. The wordmark is mono 17px, weight 500, accent colour. On the xWHM rail the mark is accent blue and the wordmark is white.

## Space, radius, shadow, border

Spacing steps are 8, 16, 24, and 32. Cards use 24px padding and 16px on narrow screens. Label-to-control gap is 8px, and the label’s content edge lines up with the control’s content edge.

Radii: 8px controls and navigation, 12px cards and dialogs, 10px code blocks, 999px pills and badges. The account menu is a pill.

Shadows: menus and dialogs use `0 8px 24px rgba(16, 24, 40, 0.12)`. Light cards stay flat with a 1px `#e2e6ec` border. Inputs use `#d0d5dd`.

## Shell

The shell is a sidebar plus a workspace. The workspace holds a white top bar (bottom border `#e2e6ec`) and the page. Page search is an elevated field, at least 44px tall, with a keyboard hint. The user control is a pill: 32px circular avatar, then the name. xPanel and xMail avatars use the soft accent tile. xWHM uses the navy avatar.

Page headers are one `h1` (`.xp-page-title`) plus an optional status badge and short prose. Navigation groups are flat labels. They do not show a count of child links. A count of accounts belongs on the accounts page, where it counts accounts.

Unavailable tool groups use the artboard’s disabled treatment: dashed `#d0d5dd` border, `#f8f9fb` fill, `#5d6b7e` text, `cursor: not-allowed`. On the navy rail and in dark mode the border is `#3a4d6b`, the fill is transparent, and the text is `#8a99af`. These rows are not links.

Chevrons point back toward the start of the line. In RTL the back icon is mirrored with a horizontal scale, using logical properties everywhere else.

## Components

- Cards: `.xp-card`, radius 12, border `#e2e6ec`, padding 24.
- Tables: header cells 12px, weight 600, colour `#475467`, padding 12px 16px. Values that are identifiers sit in `bdi dir=ltr`.
- Forms: `.xp-field` stacks a `.xp-label` and a `.xp-input` or `.xp-select`. Inputs are at least 44px, radius 8.
- Buttons: `.xp-btn`, minimum 44px, radius 8. Primary is accent fill, white text, weight 600. Destructive confirmation uses a critical outline (`.xp-btn--danger`).
- Badges: `.xp-badge`, pill, 12px weight 600, with an icon so colour is not the only signal.
- Toasts: a card with a 4px inline-start accent and the medium shadow.
- Dialogs: native `<dialog class="xp-dialog">`, max width 500px, padding 24, radius 12, the dialog shadow, and a 40% `#101828` backdrop. Header, body, and a footer of actions. Focus moves into the dialog, Escape and the backdrop cancel, and focus returns to the control that opened it.
- Empty and unavailable screens: a card with a single page title, one sentence, and a back link. Dashed empty regions use `#c9cfd8`.
- Login: a centered card, about 440px, padding 32px 28px, 26px stack gap. Audience screens (account, server, mail) replace the generic mark with a small line icon on the soft accent tile. Inputs stay 44px. Labels are 13px on the artboard and follow the product label role here.
- Status pages: the same card, a tabular status code, the explanation, and one primary action.

## Component states

Premium components is the library every screen is built from. The design system paints the same controls. These states are colour swaps. The source writes no `transition` on hover, press, focus, disabled, empty, or error.

- Hover is the link rule only: `a { color: #1D5BD6 }` and `a:hover { color: #1546A8 }`. The change is immediate. Buttons do not change fill on hover.
- Focus: `:focus-visible { outline: 2px solid #1D5BD6; outline-offset: 2px }`. Inside `nav[aria-label="xWHM navigation"]` the outline colour is `#6EA0FF`. A focused combobox and the active one-time digit add `border: 1.5px solid #1D5BD6` and `box-shadow: 0 0 0 3px #E8EFFD`. Workspace fields keep the 2px outline and leave the border colour alone, so focus stays one ring.
- Pressed chip: background `#E8EFFD`, text `#1D5BD6`, border `#C7D7F8`. Idle chip: `#FFFFFF`, `#344054`, `#D0D5DD`. Weight 600.
- Segmented control, selected: white fill, text `#101828`, shadow `0 1px 2px rgba(16, 24, 40, 0.12)` on a `#EEF0F3` track. Idle text is `#475467`.
- Switch on: track `#1D5BD6`, thumb at the end. Off: track `#98A2B3`, thumb at the start. The track is 48×28 with 3px padding. The thumb is 22px, white, shadow `0 1px 3px rgba(16, 24, 40, 0.3)`.
- Radio card, selected: `border: 1.5px solid #1D5BD6`, background `#F3F7FE`. Unselected: border `#E2E6EC`, background `#FFFFFF`. Disabled: border `#E2E6EC`, background `#F8F9FB`, text `#475467`, cursor `not-allowed`.
- Tab, selected: `border-bottom: 2px solid #1D5BD6`, colour `#1D5BD6`, weight 600. Idle: colour `#475467`, weight 500, transparent bottom border.
- Buttons are weight 600, min-height 44px, radius 8px. Primary: border and fill `#1D5BD6`, white text, padding `0 18px`. Secondary: border `#D0D5DD`, fill `#FFFFFF`, text `#101828`. Danger: border and fill `#B42318`, white text. Quiet: transparent border and fill, text `#1D5BD6`. Disabled, including hover and press: fill `#F0F2F5`, border `#E2E6EC`, text `#5D6B7E`, cursor `not-allowed`. A confirm button uses those disabled colours until the typed name matches, then the danger fill.
- Disabled field: fill `#F0F2F5`, border `#E2E6EC`, text `#5D6B7E`.
- Error field: `border: 1.5px solid #B42318`. The help line is `#B42318` at weight 500.
- Empty region: dashed border `#C9CFD8`, radius 12px. Drop zone: `1.5px dashed #9AA4B2`, fill `#F8F9FB`.
- Quota and progress fills: `#1D5BD6` below 80%, `#B54708` from 80%, `#B42318` from 95%. The track is `#E9ECF1`, 8px tall, radius 4px. The compact upload track is 4px tall, radius 2px.
- Toast, light: white, border `#E2E6EC`, radius 12px, padding 14px, shadow `0 12px 24px -10px rgba(16, 24, 40, 0.18)`. Critical border `#F4B8B2`. Undo toast: fill `#101828`, white text, shadow `0 12px 24px -10px rgba(16, 24, 40, 0.3)`.
- Alerts: info `#C7D7F8` / `#F3F7FE`, warning `#F9C9A0` / `#FFF6EE`, critical `#F4B8B2` / `#FEF3F2`.

## Motion

Premium components binds every keyframe to a duration. Those five declarations are the library timings for skeletons, spinners, progress, quota bars, and the undo drain on every screen:

- Skeleton: `animation: xp-shimmer 1.4s linear infinite`.
- Spinner: `animation: xp-spin 0.9s linear infinite`.
- Indeterminate progress: `animation: xp-indet 1.4s ease-in-out infinite`.
- Undo / toast drain: `animation: xp-drain 8s linear infinite`.
- Determinate progress and quota bars: `transition: width 0.6s ease`.

The keyframe bodies, written in the same style block, are:

- `xp-indet`: `0% { transform: translateX(-100%) }` to `100% { transform: translateX(260%) }`.
- `xp-shimmer`: `0% { background-position: -480px 0 }` to `100% { background-position: 480px 0 }`.
- `xp-spin`: `to { transform: rotate(360deg) }`.
- `xp-drain`: `from { width: 100% }` to `to { width: 0% }`.

Applied geometry from that board:

- Indeterminate bar: absolute, `inset-block: 0`, width 40%, `#1D5BD6`, radius 4px, inside the 8px `#E9ECF1` track.
- Determinate fill: `#1D5BD6` on the 8px track. The compact upload fill uses the same `transition: width 0.6s ease` on the 4px track.
- Skeleton paint: `linear-gradient(90deg, #EEF0F3 0%, #F8F9FB 50%, #EEF0F3 100%)` with `background-size: 960px 100%`.
- Spinner: the open arc `M21 12a9 9 0 1 1-9-9`, stroke `#1D5BD6`.
- Drain: 3px tall, background `#6EA0FF`.

Every screen stylesheet sets the same link and focus rules, with no `transition` on either:

- `a { color: #1D5BD6 }` and `a:hover { color: #1546A8 }`. The colour change is immediate.
- `:focus-visible { outline: 2px solid #1D5BD6; outline-offset: 2px }`.
- Inside `nav[aria-label="xWHM navigation"]`, `:focus-visible` uses `outline-color: #6EA0FF`.

Six xWHM screens (Upgrade, Transfer, SSH, Firewall, Panel security, Audit log) declare the same four keyframes and do not apply them. Premium components and those screens end the style block with:

`@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important } }`

No screen declares a spring, stiffness, damping, mass, or a drag physics config. Component styles do not use a custom `cubic-bezier`. Premium components advances the sample progress percent with `setInterval` every 900ms. That clock only replaces the sample value. The bar still uses `transition: width 0.6s ease`. Confirm panels, filter chips, the move menu, compose discard, and wizard steps appear and disappear by replacing state. There is no open or close duration on those.

The undo bar on Inbox, when a message is moved, is an instant `role="status"` strip: background `#101828`, text `#FFFFFF`, 13px, padding `8px 8px 8px 16px`, and an Undo button with `min-height: 40px`, transparent background, border `#475467`, white text. The move menu is an instant absolute list: `top: 50px`, `min-width: 200px`, radius 10, border `#E2E6EC`, shadow `0 8px 24px rgba(16, 24, 40, 0.12)`. A selected message row is `#F3F7FE` with `box-shadow: inset 3px 0 0 #1D5BD6`. The Compose control on the Compose screen is fill `#1546A8` with white text. The Inbox Compose control is fill `#1D5BD6`.

Build map, Mail Inbox, and Mail Compose use only the link and focus rules above. Build map has no keyframes. Its running wave card uses border `#C7D7F8` and `box-shadow: inset 0 3px 0 #1D5BD6`. A done wave uses `inset 0 3px 0 #0E7A4E`. Status chips are immediate colour swaps: Done `#E7F5EE` / `#0E7A4E`, Running `#E8EFFD` / `#1D5BD6`, Next `#EEF0F3` / `#344054`.

The design-tool runtime (`support.js`) is not part of the design. It paints a streaming placeholder with `animation: sc-shine 1.4s ease infinite` and knows the CSS keyword curves `ease-in` `cubic-bezier(.42, 0, 1, 1)`, `ease-out` `cubic-bezier(0, 0, .58, 1)`, and `ease-in-out` `cubic-bezier(.42, 0, .58, 1)`. No component uses those curves.

A live read of the Inbox artboard agrees with the source text. Keyboard focus draws `2px solid #1D5BD6` with offset `2px`. `transition-duration` on those controls is `0s` (the initial value; the shorthand reports `all` because no transition was declared). Selecting a message and opening the upgrade confirm panel both replace the markup in the same turn.

The product stylesheet copies the four keyframes and applies the five Premium components timings wherever those parts render. Quota and progress fills set `width` and `transition: width 0.6s ease`. In Arabic the fill uses `margin-left: auto` so the bar sits on the inline-start edge. The spinner uses `animation: xp-spin 0.9s linear infinite`. The indeterminate bar uses `animation: xp-indet 1.4s ease-in-out infinite`. Skeleton blocks use `animation: xp-shimmer 1.4s linear infinite` and the 960px gradient. The toast drain uses `animation: xp-drain 8s linear infinite` at 3px and `#6EA0FF`. Disabled buttons and fields use `#F0F2F5` / `#E2E6EC` / `#5D6B7E`. An invalid field uses the 1.5px `#B42318` border. Pressed chips, the switch, segmented selection, radio cards, and tabs use the colours in Component states. Unclassed links use the accent and the accent hover with no transition. `prefers-reduced-motion: reduce` sets `animation: none !important; transition: none !important`. The Compose control on the Compose screen uses fill `#1546A8`, white text, and no inset bar. A selected message row uses `#F3F7FE` and `inset 3px 0 0 #1D5BD6`.

The mobile navigation sheet and the command palette are not in the artboards. Their controller stays so a reversal does not jump and so a link navigates in the same event: 200ms for the sheet, 160ms for the palette, easing `cubic-bezier(0.2, 0.8, 0.2, 1)`, fill `both`. Reduced motion skips that controller and leaves no running animation. Those two numbers are the controller's own values. They are not artboard values.

## What the artboards do not include

The exported screens do not define a full dark content theme, status-code pages, or a live “connecting” indicator. Dark colours come from the navy rail and code blocks. Status pages reuse the card, type, and button rules. The live badge starts as “Connecting” and becomes “Live” only after the socket opens.
