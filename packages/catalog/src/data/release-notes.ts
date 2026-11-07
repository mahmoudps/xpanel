import { msgid } from '@xpanel/core'

export interface ReleaseNotesEntry { version: string; notes: readonly string[] }

/**
 * Release notes, newest first. This file ships in the release tree, so the release manifest's digest of it covers
 * every word. Add one entry with each release; a version without an entry shows as having no published notes.
 */
export const releaseNotes: readonly ReleaseNotesEntry[] = [
  { version: '0.1.31', notes: [msgid('A native upgrade retires its previous release after a healthy switch.'), msgid('The panel TLS unit stays settled when the management hosts are read during an upgrade.')] },
  { version: '0.1.30', notes: [msgid('The upgrade health check waits for the whole held account request.')] },
  { version: '0.1.29', notes: [msgid('The upgrade health check keeps its context across native callbacks.'), msgid('The rewind holds the panel state trees and carries the generation journal.')] },
  { version: '0.1.28', notes: [msgid('Database reads during an upgrade retry a write-ahead log collision.'), msgid('The rewind restores state together with the live generation journal.')] },
]
