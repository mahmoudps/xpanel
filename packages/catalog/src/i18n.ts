import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Catalog text is translated like UI copy: the record's English `name`/`summary` is the gettext msgid in
// ./locales/<BCP 47 tag>.po. A record key below is the msgctxt only where one English name needs a
// different translation for that record.
export const catalogKeys = {
  groupName: (id: string) => `catalog.group.${id}.name`,
  toolName: (id: string) => `catalog.tool.${id}.name`,
  toolSummary: (id: string) => `catalog.tool.${id}.summary`,
  sectionName: (surface: string, id: string) => `nav.section.${surface}.${id}.name`,
  pageName: (surface: string, id: string) => `nav.page.${surface}.${id}.name`,
  /** Context of a page's extra search keywords (msgid `keywords`), comma separated in each locale. */
  pageKeywords: (surface: string, id: string) => `nav.page.${surface}.${id}.keywords`,
}

/** Directory of the catalog's PO files (a file path; test DOM environments replace the global URL). */
export const CATALOG_LOCALE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'locales')
