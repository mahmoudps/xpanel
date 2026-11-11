/// <reference lib="dom" />

/**
 * Every body cell of a table marked `data-phone-labels` gets `data-phone-label`: the translated name of its column.
 * Themes that lay table rows out as phone cards read it with `content: attr(data-phone-label)`, so row
 * renderers in clients need no inline styles. Rows added later by a client are labelled as they arrive.
 */
export function bindTablePhoneLabels(): void {
  const label = (table: HTMLTableElement): void => {
    const head = table.tHead?.rows[0]
    if (!head) return
    const names: string[] = []
    for (const cell of Array.from(head.cells)) for (let span = 0; span < Math.max(1, cell.colSpan); span++) names.push((cell.textContent ?? '').trim())
    for (const body of Array.from(table.tBodies)) for (const row of Array.from(body.rows)) {
      let column = 0
      for (const cell of Array.from(row.cells)) {
        const name = cell.colSpan > 1 ? '' : names[column] ?? ''
        // A cell the page already labels (itself or a child) keeps its own label.
        if (name && cell.dataset.phoneLabel === undefined && !cell.querySelector('[data-phone-label]')) cell.dataset.phoneLabel = name
        column += Math.max(1, cell.colSpan)
      }
    }
  }
  const sweep = (root: ParentNode): void => root.querySelectorAll<HTMLTableElement>('table[data-phone-labels]').forEach(label)
  sweep(document)
  let queued = false
  new MutationObserver(() => {
    if (queued) return
    queued = true
    queueMicrotask(() => { queued = false; sweep(document) })
  }).observe(document.body, { childList: true, subtree: true })
}

export const TABLE_PHONE_LABELS_CLIENT_BINDING = bindTablePhoneLabels.toString()
