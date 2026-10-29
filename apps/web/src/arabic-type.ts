/** Arabic-script type layer. LTR keeps the board stack, sizes, and tracking. */
import { LOCALES } from '@xpanel/core'

// Arabic-script locales from the registry; their pages and lang-tagged fragments use this layer.
const ARABIC_LANG = `:is(${LOCALES.filter(info => info.script === 'Arab').map(info => `[lang="${info.tag}"]`).join(', ')})`
const ARABIC_HTML = `html${ARABIC_LANG}`

export const BOARD_SANS_LTR = "'IBM Plex Sans', sans-serif"
export const BOARD_SANS_RTL = 'sans-serif'

const ARABIC_LETTER = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFC]/

/** A whole sentence: Arabic words, digits, and punctuation, with no Latin identifier. */
export const isArabicSentence = (value: string): boolean => {
  const text = value.trim()
  if (!ARABIC_LETTER.test(text)) return false
  return !/[A-Za-z@/\\]/.test(text)
}

const ar = (selector: string): string => {
  const port = '.xp-board-port'
  const onPort = selector.startsWith(port)
    ? `.xp-board-port[dir=rtl]${selector.slice(port.length)}`
    : `[dir=rtl] ${selector}`
  return [`${ARABIC_HTML} ${selector}`, `html[dir=rtl] ${selector}`, onPort].join(',\n')
}

const size = (px: string): string => `[style*="font-size: ${px}"], [style*="font-size:${px}"]`

/** Body copy that is still 13–14px. Technical LTR islands, mono, controls, and pills stay put. */
const body13 = `:is(${size('13px')}, ${size('14px')}):not([dir="ltr"]):not([style*="Plex Mono"]):not([style*="999px"]):not(bdi[dir="ltr"]):not(code):not(kbd):not(dt):not(label):not(button):not(input):not(select):not(textarea):not(a):not(h1):not(h2):not(h3):not(h4):not(h5):not(h6):not(table):not(td):not(th)`

/** Section labels and captions. Pills and mono values are not captions. */
const caption = `:is(${size('11px')}, ${size('12px')}):not(p):not([dir="ltr"]):not([style*="Plex Mono"]):not([style*="999px"]):not(bdi[dir="ltr"]):not(code):not(kbd):not(button):not(h1):not(h2):not(h3):not(h4):not(h5):not(h6)`

const heading = (px: string, next: string): string => `${ar(`:is(h1, h2, h3, h4, h5, h6, [role="heading"]):is(${size(px)})`)} {
  font-size: ${next} !important;
  line-height: 1.5 !important;
}`

export const ARABIC_TYPE_CSS = `
.xp-board-port { font-family: ${BOARD_SANS_LTR}; }
${ARABIC_HTML} .xp-board-port,
html[dir=rtl] .xp-board-port,
.xp-board-port[dir=rtl] { font-family: ${BOARD_SANS_RTL}; }
${ARABIC_HTML} body,
html[dir=rtl] body { font-family: ${BOARD_SANS_RTL}; }
${ar('*')},
${ARABIC_HTML},
html[dir=rtl],
[dir=rtl] { letter-spacing: 0 !important; }
${ar(caption)} {
  font-size: 12.5px !important;
  line-height: 1.6 !important;
  overflow-wrap: anywhere;
  min-inline-size: 0;
}
${ar(`${caption}:is(nav span[id], .xp-nav-group__label, .xp-nav-section__title)`)},
${ar('.xp-nav-group__label')},
${ar('.xp-nav-section__title')} {
  font-size: 14px !important;
  line-height: 1.75 !important;
}
${ar(`:is(${size('11px')}):is([style*="999px"], .xp-nav-soon)`)},
${ar('.xp-nav-soon')} {
  font-size: 12px !important;
}
${ar(body13)},
${ar(`p:is(${size('12px')}, ${size('13px')}, ${size('14px')})`)} {
  font-size: 16px !important;
  line-height: 1.75 !important;
  overflow-wrap: anywhere;
  min-inline-size: 0;
}
${heading('13px', '15px')}
${heading('15px', '17px')}
${heading('16px', '18px')}
${heading('20px', '22px')}
${heading('22px', '24px')}
${ar('.xp-page-title')} {
  font-size: calc(var(--xp-type-page) + 2px) !important;
  line-height: 1.5 !important;
}
${ar(':is(.xp-dialog__header, .xp-account-dialog__header) > h2')} {
  font-size: calc(var(--xp-type-card) + 2px);
  line-height: 1.5;
}
${ar('.xp-board-port nav a:not([style*="background: #1D5BD6"])')},
${ar('.xp-nav-item')} {
  font-size: 16px !important;
  line-height: 1.75 !important;
  font-weight: 500 !important;
  min-inline-size: 0;
  height: auto;
  white-space: normal;
}
${ar('[data-tool="true"] > a')} {
  font-size: 16px !important;
  line-height: 1.75 !important;
}
${ar('[data-tool="true"] > a > span:not([aria-hidden="true"]):not([data-meta])')} {
  flex: 0 0 auto !important;
  min-width: max-content !important;
  min-inline-size: max-content !important;
  white-space: nowrap !important;
}
${ar('[data-meta]')} {
  display: inline-flex !important;
  align-items: baseline;
  gap: 0.35em;
  overflow: visible !important;
}
${ar('[data-tool="true"] > a > [data-meta]')} {
  flex: 1 1 auto !important;
  min-width: 0 !important;
  min-inline-size: 0 !important;
}
${ar('[data-meta-label]')} {
  flex: 0 1 auto !important;
  min-width: 0 !important;
  min-inline-size: 0 !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
}
${ar('[data-meta-value]')} {
  flex: none !important;
  min-inline-size: max-content !important;
}
/* LTR values keep their intrinsic width but break when a constrained field cannot hold them. */
${ar('bdi[dir="ltr"]')} {
  flex-shrink: 0 !important;
  white-space: normal !important;
  overflow-wrap: break-word !important;
  overflow: visible !important;
  text-overflow: clip !important;
}
/* Technical table tokens stay whole; their table region scrolls instead. */
${ar('bdi[dir="ltr"]:is(.xp-chart-technical-value, .xp-plan-resource-value, .xp-technical-token)')} {
  white-space: nowrap !important;
  overflow-wrap: normal !important;
}
${ar('bdi[dir="ltr"][style*="overflow-wrap: anywhere"]')},
${ar('[aria-labelledby="host-title"] dd bdi[dir="ltr"]')} {
  white-space: normal !important;
  overflow-wrap: anywhere !important;
  flex-shrink: 1 !important;
  min-inline-size: 0 !important;
}
[aria-labelledby="host-title"] dd {
  min-inline-size: 0;
  max-inline-size: 100%;
}
${ar('[style*="Plex Mono"]')},
${ar('.xp-mono')},
${ar('code')} {
  font-family: 'IBM Plex Mono', monospace !important;
}
.xp-ar-sentence,
${ARABIC_LANG}:not(code):not(pre):not(kbd):not(.xp-mono) {
  font-family: ${BOARD_SANS_RTL} !important;
}
${ar('a[data-usage-link]')} {
  font-size: 14px !important;
  line-height: 1.75 !important;
}
${ar('[data-board-port="xmail-inbox"] :is([data-mail-addr], [data-mail-mailbox], [data-mail-from], [data-mail-pane="reading-pane"] [style*="999px"]) bdi[dir="ltr"]')} {
  white-space: normal !important;
  overflow-wrap: anywhere !important;
  flex-shrink: 1 !important;
  min-inline-size: 0 !important;
  max-inline-size: 100% !important;
}
${ar('[data-mail-name] bdi[dir="ltr"]')} {
  display: block !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
  max-inline-size: 100% !important;
  min-inline-size: 0 !important;
}
${ar('table')} {
  width: 100% !important;
  table-layout: auto;
}
/* Table text follows the typography roles: headers use the label role, cells the body role. */
${ar('table th')} {
  line-height: var(--xp-leading-label) !important;
}
${ar('table td')} {
  line-height: var(--xp-leading-body) !important;
}
${ar('th')} {
  white-space: nowrap !important;
  overflow-wrap: normal !important;
}
/* Tokens in scrolling native tables stay on one line; .xp-table cells opt into wrapping below. */
${ar('table:not(.xp-table) td bdi[dir="ltr"]:not([style*="overflow-wrap: anywhere"])')} {
  white-space: nowrap !important;
}
${ar('table span[style*="overflow-wrap: anywhere"] bdi[dir="ltr"]:not(.xp-chart-technical-value):not(.xp-plan-resource-value):not(.xp-technical-token)')},
${ar('table div[style*="align-items: flex-start"] span bdi[dir="ltr"]:not(.xp-chart-technical-value):not(.xp-plan-resource-value):not(.xp-technical-token)')},
${ar('.xp-table td bdi[dir="ltr"]:not(.xp-chart-technical-value):not(.xp-plan-resource-value):not(.xp-technical-token)')} {
  white-space: normal !important;
  overflow-wrap: anywhere !important;
  flex-shrink: 1 !important;
  min-inline-size: 0 !important;
}
${ar('table :is([style*="999px"], .xp-badge)')} {
  white-space: nowrap !important;
  overflow-wrap: normal !important;
  max-inline-size: none !important;
}
${ar('.xp-board-port nav a :is(span, bdi)')},
${ar('.xp-nav-item span')} {
  min-inline-size: 0;
  overflow-wrap: anywhere;
  white-space: normal;
}
${ar('.xp-board-port :is(th, td)')},
${ar('.xp-table :is(th, td)')} {
  overflow-wrap: anywhere;
  min-inline-size: 0;
  white-space: normal;
  height: auto;
}
${ar('.xp-table :is(th, td)')} { min-block-size: 44px; }
${ar('.xp-board-port th[style*="width: 72px"]')} { width: auto !important; }
${ar('.xp-board-port [style*="999px"]')},
${ar('.xp-badge')} {
  max-inline-size: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
}
${ARABIC_HTML} .xp-board-port[data-home-phone="true"],
.xp-board-port[dir=rtl][data-home-phone="true"] {
  overflow-x: hidden !important;
  overflow-y: auto !important;
}
[data-section="audit-log"] {
  display: grid;
  gap: var(--xp-space-card, 24px);
  padding: var(--xp-space-card, 24px);
}
[data-section="audit-log"] > .xp-card__header,
[data-section="audit-log"] .xp-page-title { margin: 0; }
@media (max-width: 640px) {
  [data-section="audit-log"] { padding: var(--xp-space-field, 16px); }
}
[data-section="audit-log"] .xp-audit-mobile-label {
  display: none;
  font-family: var(--xp-font-sans-ltr, ${BOARD_SANS_LTR});
  font-size: 14px;
  font-weight: 500;
  line-height: var(--xp-leading-label, 22px);
  color: var(--xp-text-muted);
}
${ar('[data-section="audit-log"] .xp-audit-mobile-label')} {
  font-family: var(--xp-font-sans-rtl, ${BOARD_SANS_RTL});
}
[data-section="audit-log"] .xp-audit-value { min-inline-size: 0; }
@media (min-width: 391px) {
  [data-section="audit-log"] th { text-align: start; }
}
[data-section="audit-log"] [data-audit-filters] input { min-block-size: 44px; }
@media (max-width: 390px) {
  [data-section="audit-log"] :is(table, thead, tbody, tr) {
    display: block !important;
    width: 100% !important;
    min-inline-size: 0;
    box-sizing: border-box;
  }
  [data-section="audit-log"] thead tr {
    display: flex !important;
    flex-wrap: wrap;
  }
  [data-section="audit-log"] th {
    display: block !important;
    flex: 1 1 auto;
    width: auto !important;
    min-block-size: 44px;
    padding-inline: 4px;
  }
  [data-section="audit-log"] tbody {
    display: grid !important;
    gap: var(--xp-space-card, 24px);
    margin-block-start: var(--xp-space-card, 24px);
  }
  [data-section="audit-log"] tbody tr {
    display: grid !important;
    gap: var(--xp-space-field, 16px);
    padding: var(--xp-space-field, 16px);
  }
  [data-section="audit-log"] td {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
    min-inline-size: 0;
    height: auto;
    padding: 0;
    font-size: 16px;
  }
  [data-section="audit-log"] .xp-audit-value > :is(time, bdi.xp-mono) { font-size: 14px; }
  [data-section="audit-log"] .xp-audit-mobile-label { display: block; }
  ${ar(':is(table, thead, tbody, tr, th, td):not(.xp-table):not(.xp-table *):not(.xp-accounts__table):not(.xp-accounts__table *)')} {
    display: block !important;
    width: 100% !important;
    min-width: 0 !important;
    box-sizing: border-box;
  }
  ${ar('.xp-board-port')},
  .xp-board-port[dir=rtl] { max-inline-size: 100%; }
  ${ar('.xp-board-port > nav')},
  .xp-board-port[dir=rtl] > nav,
  ${ar('.xp-sidebar')} {
    flex-basis: 100%;
    max-inline-size: 100%;
    min-inline-size: 0;
  }
  ${ar('.xp-board-port :is(section, div):has(> table)')},
  .xp-board-port[dir=rtl] :is(section, div):has(> table) {
    overflow-x: auto;
    max-inline-size: 100%;
  }
}
`
