---
name: design-board-pixel-port
description: Port each design board 1:1 into the app and gate it with pixelmatch. Use for every xWHM, xPanel, and xMail screen. Board export HTML stays out of the repo.
---

# Design-board pixel port: mandatory method for every screen

You are porting design boards (exported `<Board>.dc.html` plus `support.js`) into a real app. The goal is a 1:1 replica, not an interpretation. Generic re-layouts are rejected on sight.

The board exports themselves stay out of the repo. Read them from the design store. Do not commit `.dc.html`, `support.js`, or vendor copies.

## 0. Read before coding
- Open the board in a real browser (serve the folder with `python3 -m http.server`) at the board's native viewport. Screenshot it. This is the target.
- Inventory every region top to bottom: chrome (sidebar, top bar), breadcrumb, title block, primary action, banners, cards, tiles, tables, meters, lists, footers and links. Write the list down before writing code.
- Extract the exact values from the inline styles and the `<helmet><style>`: px sizes, gaps, paddings, radii, borders, shadows, colors, font family, size, weight, line-height, letter-spacing, icon set and size.

## 1. Port; never restyle
- Translate the board's DOM structure 1:1 into app components (same nesting, same grid and flex, same order).
- Reuse the shared chrome (sidebar and top bar) built once from the boards. Never use the app's older generic components if they differ from the board.
- Use the same icons, at the same size and stroke.
- Copy text structure stays identical. Only data values change.

## 2. Data binding without layout collapse
- Bind real data into the SAME tiles, cards and rows.
- For missing or unknown values, keep the component and show the board's empty treatment ('—', 0, or the board's empty sentence). Never replace a card grid with a plain table or a single "unavailable" line.
- No invented production data. Sample content lives ONLY in a test-fixture harness that is never routed in the product.
- Unwired actions are rendered exactly as in the board, but disabled, with a subtle 'قيد التفعيل / Coming soon' hint.

## 3. Pixel gate (mandatory, per screen)
- Test-only harness: render the app page with a fixture mirroring the board's sample content, at the board's exact viewport and DPR, with fonts loaded and animations paused.
- pixelmatch at threshold 0.1: **3% or less differing pixels** for LTR, and also for the RTL mirror.
- Publish board, app and diff images, plus a per-screen table of diff % in the PR. A screen above 3% is NOT done.
- Also screenshot the REAL product route with real (possibly empty) data, and confirm that the structure is identical to the board (same regions present).

## 4. RTL correctness (Arabic)
- Use logical CSS only (margin-inline, inset-inline, text-align: start). Mirror the layout and keep the chevrons and icons facing the logical direction.
- Wrap numbers, units, versions, IPs, paths, code, emails and domains in `<bdi>` or `dir="ltr"` spans, so "41 days, 6 hours", "3.4 / 8 GB" and "v1.4.2" never get scrambled, and so sentence punctuation doesn't jump to the wrong end.
- The RTL screenshot uses translated Arabic copy. Do not flip an English page and call that RTL.
- Status pills put the dot on the inline-start side. Check this visually in the RTL screenshot before claiming the screen passes.

## 5. Motion and states
- Port the animations and transitions literally from the board and the Premium components board (durations, easings, keyframes). Don't invent any.
- Replicate the hover, pressed, focus, disabled, loading, empty and error states from the components board, and respect `prefers-reduced-motion`.
- Verify with frame captures at 0%, 50% and 100% of each animation, compared against the board.

## 6. Done means
- Every region in the inventory is present.
- LTR and RTL both pass the 3% gate.
- The RTL bidi check passes.
- Motion is verified.
- The real route shows the same structure.
- typecheck and tests pass locally.
