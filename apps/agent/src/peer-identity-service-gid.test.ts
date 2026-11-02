import { describe, expect, it } from 'vitest'
import { resolveServicePrimaryGid } from './peer-identity.ts'

const passwd = 'root:x:0:0:root:/root:/bin/bash\nxpanel:x:999:988::/var/lib/xpanel:/usr/sbin/nologin\n'

describe('service primary group', () => {
  it('returns the API uid primary group, not a supplementary socket group', async () => {
    await expect(resolveServicePrimaryGid(999, passwd)).resolves.toBe(988)
  })

  it('refuses a missing, duplicate or root identity', async () => {
    await expect(resolveServicePrimaryGid(1234, passwd)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(resolveServicePrimaryGid(999, passwd + 'other:x:999:5::/:/bin/false\n')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(resolveServicePrimaryGid(0, passwd)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
