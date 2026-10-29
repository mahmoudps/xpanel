// v2 icon set: stroke paths on a 24 grid (stroke 2, round caps), drawn from the v2 design boards.

const PATHS = {
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  alert: 'M12 3l9.5 17h-19zM12 10v4M12 17h.01',
  archive: 'M3 4h18v5H3zM5 9v11h14V9M10 13h4',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4',
  calendar: 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 10h18M8 3v4M16 3v4',
  check: 'M5 12l5 5L20 7',
  chevDown: 'M6 9l6 6 6-6',
  chevLeft: 'M15 6l-6 6 6 6',
  chevRight: 'M9 6l6 6-6 6',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  cpu: 'M8 7h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  database: 'M4 6a8 3 0 1 0 16 0a8 3 0 1 0-16 0M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  disk: 'M4 5h16v14H4zM4 14h16M8 17h.01',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  files: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  filter: 'M3 5h18l-7 8v6l-4 1v-7z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  gear: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1',
  globe: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  home: 'M3 11l9-7 9 7M5 9.5V20h14V9.5M10 20v-6h4v6',
  inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1.5 2.5h5L16 13h5',
  info: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 8h.01M11 12h1v4h1',
  language: 'M4 5h9M8.5 3v2M6 5c.8 3.4 3 6 6 7.5M11 5c-.8 3.4-3 6-6 7.5M13 21l4-9 4 9M14.5 18h5',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5',
  mail: 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 7l9 6 9-6',
  memory: 'M3 8h18v8H3zM7 8v8M11 8v8M15 8v8M6 16v3M18 16v3',
  menu: 'M4 6h16M4 12h16M4 18h16',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  okCircle: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M8 12.5l2.5 2.5L16 9.5',
  package: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  search: 'M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0M20 20l-4-4',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  services: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  shield: 'M12 3l7 3v5c0 4.4-3 8.3-7 10c-4-1.7-7-5.6-7-10V6zM9 12l2 2 4-4',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M13 7a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  tools: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z',
  user: 'M8 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0M4 21c0-4 3.6-7 8-7s8 3 8 7',
  users: 'M5.5 8a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 0 1 0 7M21 20c0-2.8-1.6-5-4-5.7',
  x: 'M6 6l12 12M18 6L6 18',
  xCircle: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M9 9l6 6M15 9l-6 6',
} as const

export type IconName = keyof typeof PATHS

/** Icons that point along the reading direction and mirror in RTL; every other icon never mirrors. */
const DIRECTIONAL: ReadonlySet<IconName> = new Set(['arrow', 'chevLeft', 'chevRight'])

/** Catalog section icons (lucide names in `@xpanel/catalog` navigation data) drawn with the v2 set. */
const CATALOG_ICONS: Readonly<Record<string, IconName>> = {
  Activity: 'activity', ArchiveRestore: 'archive', Boxes: 'package', CalendarDays: 'calendar', Code: 'code',
  Database: 'database', FolderOpen: 'folder', Globe: 'globe', HardDrive: 'disk', Inbox: 'inbox',
  LayoutDashboard: 'home', ListFilter: 'filter', Mail: 'mail', Package: 'package', Server: 'server',
  ServerCog: 'services', ShieldCheck: 'shield', SlidersHorizontal: 'sliders', Store: 'package',
  UserCog: 'user', Users: 'users', Wrench: 'tools',
}

export const catalogIcon = (lucideName: string): IconName => CATALOG_ICONS[lucideName] ?? 'layers'

/** A decorative inline icon; meaning is always carried by adjacent text or an `aria-label` on the control. */
export const icon = (name: IconName, size = 18): string =>
  `<svg class="v2-icon${DIRECTIONAL.has(name) ? ' v2-flip' : ''}" aria-hidden="true" focusable="false" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${PATHS[name]}"/></svg>`
