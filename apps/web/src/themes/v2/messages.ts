import { loadThemeMessagesFromModule } from '../../theme-messages.ts'

/** Own copy is isolated from core and other themes; common product copy still uses core's catalog. */

export const v2Messages = loadThemeMessagesFromModule('v2', import.meta.url)
