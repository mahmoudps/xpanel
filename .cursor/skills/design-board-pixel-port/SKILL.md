---
name: design-board-pixel-port
description: Port each design board 1:1 into the app and gate it with pixelmatch plus a content-truth table. Use for every xWHM, xPanel, and xMail screen. Board export HTML stays out of the repo.
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
- For a value that was read as empty, or that was not observed, keep the component and show the board's empty treatment ('—', 0, or the board's empty sentence). Where the data exists, show that data. Never replace a card grid with a plain table or a single "unavailable" line.
- No invented production data. Sample content lives ONLY in a test-fixture harness that is never routed in the product.
- Unwired actions are rendered exactly as in the board, but disabled, with a subtle 'قيد التفعيل / Coming soon' hint.

## 3. Pixel gate (mandatory, per screen)
- Test-only harness: render the app page with a fixture mirroring the board's sample content, at the board's exact viewport and DPR, with fonts loaded and animations paused.
- pixelmatch at threshold 0.1, `includeAA: false`. The screen passes only when the whole page is **≤0.5%** and every **200×200** tile is **≤1%**. The capture is the product route (`renderWebApp`), with the board's sample content injected from a test fixture. A byte-identical board/app pair is refused, even at 0.00%. A 1px pad of the port root must fail this same gate, and that negative control runs in the test suite.
- Arabic is a visual check, not this pixel gate.
- Publish board, app and diff images, plus a per-screen table of diff % in the PR. A screen that misses either limit is NOT done. A screen inside both limits is also not done until the content-truth table in section 7 is attached.
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
- LTR passes the strict gate (≤0.5% page, ≤1% per 200×200 tile, distinct captures, failing 1px control). Arabic stays a visual check.
- The RTL bidi check passes.
- Motion is verified.
- The real route shows the same structure.
- The PR includes the content-truth table from section 7, and each bound value matches its source.
- typecheck and tests pass locally.

## 7. Content truth

Pixel match is not enough. For every screen you port, attach a content-truth table in the pull request. The owner checks every value against the server before merging.

Columns, in this order: **field · shown · real · source**. The source is the API, the database, or the command that produced the value.

One table for the product route. The fidelity fixture is a separate note: its sample numbers are the board's copy, they are not a product route, and they are not evidence that the live page is correct.

Check every bound value:

- **Units are labelled for the unit that is stored and enforced.** A quota or size kept as a count of `n * 1024 * 1024` bytes (Dovecot `storage=<n>M` is 2^20) is MiB, not MB. A decimal gigabyte on the artboard stays on the fixture. Do not relabel the fixture, and do not copy the fixture's GB string onto a MiB field.
- **Times that are instants carry a labelled timezone.** A parsed mail time is UTC (`HH:MM UTC`, and the full stamp `YYYY-MM-DD HH:MM UTC`). Text that did not parse is shown unchanged. Do not invent a zone for it.
- **Lists are complete.** A mailbox, an account list, or a filter list is the full result of its read. Do not drop rows to fit the board's sample count. If a pager is real, the page says which slice it is and how many exist.
- **No raw codes.** Conditions, actions, and statuses are words (From, contains, Discard, File into, paused), not the stored enum.
- **No fake 0, and no dash where the data exists.** A dash or a zero means the read came back empty, or the value was not observed. An unread list is not "0 messages". An unmeasured quota is not "0 MiB". A missing file is not "Off". A code default that was never saved is not a saved setting.
