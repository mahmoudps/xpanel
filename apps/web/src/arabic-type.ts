/** Arabic-only type layer. LTR keeps the board stack, sizes, and tracking. */

export const BOARD_SANS_LTR = "'IBM Plex Sans', 'IBM Plex Sans Arabic', system-ui, sans-serif"
export const BOARD_SANS_RTL = "'IBM Plex Sans Arabic', 'IBM Plex Sans', system-ui, sans-serif"

const ar = (selector: string): string =>
  [`html[lang="ar"] ${selector}`, `html[dir=rtl] ${selector}`, `[dir=rtl] ${selector}`].join(',\n')

const size = (px: string): string => `[style*="font-size: ${px}"], [style*="font-size:${px}"]`

/** Body copy that is still 12–13px. Technical LTR islands, mono, controls, and pills stay put. */
const body13 = `:is(${size('13px')}):not([dir="ltr"]):not([style*="Plex Mono"]):not([style*="999px"]):not(bdi[dir="ltr"]):not(code):not(kbd):not(dt):not(label):not(button):not(input):not(select):not(textarea):not(a):not(h1):not(h2):not(h3):not(h4):not(h5):not(h6):not(th)`

/** Section labels and captions. Pills and mono values are not captions. */
const caption = `:is(${size('11px')}, ${size('12px')}):not(p):not([dir="ltr"]):not([style*="Plex Mono"]):not([style*="999px"]):not(bdi[dir="ltr"]):not(code):not(kbd):not(button):not(h1):not(h2):not(h3):not(h4):not(h5):not(h6)`

const heading = (px: string, next: string): string => `${ar(`:is(h1, h2, h3, h4, h5, h6, [role="heading"]):is(${size(px)})`)} {
  font-size: ${next} !important;
  line-height: 1.5 !important;
}`

export const ARABIC_TYPE_CSS = `
.xp-board-port { font-family: ${BOARD_SANS_LTR}; }
html[lang="ar"] .xp-board-port,
html[dir=rtl] .xp-board-port,
.xp-board-port[dir=rtl] { font-family: ${BOARD_SANS_RTL}; }
html[lang="ar"] body,
html[dir=rtl] body { font-family: ${BOARD_SANS_RTL}; }
${ar('*')},
html[lang="ar"],
html[dir=rtl],
[dir=rtl] { letter-spacing: 0 !important; }
${ar(caption)} {
  font-size: 12.5px !important;
  line-height: 1.6 !important;
  overflow-wrap: anywhere;
  min-inline-size: 0;
}
${ar(`:is(${size('11px')}):is([style*="999px"], .xp-nav-soon)`)},
${ar('.xp-nav-soon')} {
  font-size: 12px !important;
}
${ar(body13)},
${ar(`p:is(${size('12px')}, ${size('13px')}, ${size('14px')})`)} {
  font-size: 14.5px !important;
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
${ar('.xp-nav-group__label')} { font-size: 12.5px; line-height: 1.6; }
${ar('.xp-board-port nav a:not([style*="background: #1D5BD6"])')},
${ar('.xp-nav-item')} {
  font-weight: 500 !important;
  min-inline-size: 0;
  height: auto;
  white-space: normal;
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
html[lang="ar"] .xp-board-port[data-home-phone="true"],
.xp-board-port[dir=rtl][data-home-phone="true"] {
  overflow-x: hidden !important;
  overflow-y: auto !important;
}
@media (max-width: 390px) {
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
