// Message keys for catalog text. The English source string is the record's `name`/`summary`;
// every other language is a flat `key → text` file in ./locales (one file per BCP 47 tag).
export const catalogKeys = {
  groupName: (id: string) => `catalog.group.${id}.name`,
  toolName: (id: string) => `catalog.tool.${id}.name`,
  toolSummary: (id: string) => `catalog.tool.${id}.summary`,
  sectionName: (surface: string, id: string) => `nav.section.${surface}.${id}.name`,
  pageName: (surface: string, id: string) => `nav.page.${surface}.${id}.name`,
}
