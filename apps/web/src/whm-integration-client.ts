import { WHM_DEVELOPER_CLIENT_BINDING } from './whm-developer-client.ts'

/** The finite console binds the integrations root too; its manifest permits only own token metadata. Bind once per document. */
export const WHM_INTEGRATION_CLIENT_BINDING = WHM_DEVELOPER_CLIENT_BINDING
