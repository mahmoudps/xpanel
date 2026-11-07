import { WHM_DB_ROOT_PASSWORD_CLIENT_BINDING } from './whm-db-root-password-client.ts'
import { FTP_TOOLS_CLIENT_BINDING } from './ftp-tools-client.ts'
import { WHM_DB_TOOLS_CLIENT_BINDING } from './whm-db-tools-client.ts'
import { WHM_DB_PROFILES_CLIENT_BINDING } from './whm-db-profiles-client.ts'
import { DNS_CLUSTER_CLIENT_BINDING } from './dns-cluster-client.ts'
import { WHM_DB_SERVICES_CLIENT_BINDING } from './whm-db-services-client.ts'

/** Database, FTP and DNS cluster administration clients, mounted from ws-client with one call. */
export const DB_FTP_CLIENT_BINDINGS = `(askDialog=>{(${WHM_DB_ROOT_PASSWORD_CLIENT_BINDING})(askDialog);(${FTP_TOOLS_CLIENT_BINDING})(askDialog);(${WHM_DB_TOOLS_CLIENT_BINDING})(askDialog);(${WHM_DB_PROFILES_CLIENT_BINDING})(askDialog);(${DNS_CLUSTER_CLIENT_BINDING})(askDialog);(${WHM_DB_SERVICES_CLIENT_BINDING})(askDialog);})`
