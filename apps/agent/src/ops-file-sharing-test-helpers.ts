import { parseManagedExports } from './ops-file-sharing.ts'

/** Test-only synthetic etab for a managed file: one exported directory line per configured share. */
export const parseExpectedEtab = (managed: string): string => parseManagedExports(managed).shares.map(share => '"' + share.path + '"\t*(rw)').join('\n') + '\n'
