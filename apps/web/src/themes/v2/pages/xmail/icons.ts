const PATHS = {
  compose: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  attach: 'M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  bold: 'M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z',
  italic: 'M19 4h-9M14 20H5M15 4L9 20',
  underline: 'M7 4v7a5 5 0 0 0 10 0V4M5 20h14',
  bullets: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  numbers: 'M10 6h10M10 12h10M10 18h10M4 5h1v4M6 18H4l2-2.5a1.2 1.2 0 0 0-2-1',
  quote: 'M6 8h4v4H6zM6 12c0 2.5-.8 4-2.5 5M14 8h4v4h-4zM14 12c0 2.5-.8 4-2.5 5',
  link: 'M10 14a4 4 0 0 0 6 .5l3-3a4 4 0 0 0-5.7-5.7L12 7M14 10a4 4 0 0 0-6-.5l-3 3a4 4 0 0 0 5.7 5.7L12 17',
  clear: 'M5 5h11M10.5 5L8 19M4 20l16-16',
} as const

export type MailIcon = keyof typeof PATHS
export const mailIcon = (name: MailIcon, size = 18): string => `<svg class="v2-icon" aria-hidden="true" focusable="false" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${PATHS[name]}"/></svg>`
