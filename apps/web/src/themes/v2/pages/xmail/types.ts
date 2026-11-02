import type { MailSurfaceProps, ThemeViewProps } from '../../../contract.ts'
import type { MailSurfaceView } from '../../../../models/mail.ts'

export type {
  MailPageFacts, MailFolderFacts, MailMessageFacts, MailInboxView, MailComposeView,
  MailView as V2MailView,
  MailWorkspaceView, MailWorkspaceRoute, MailSurfaceView as V2MailSurfaceView,
} from '../../../../models/mail.ts'

export type V2MailProjector = (props: MailSurfaceProps & ThemeViewProps) => MailSurfaceView | undefined
