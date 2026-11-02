// Synthetic browser fixture only: the verified account-create acknowledgement shape. It qualifies no hosting server.
export function verifiedAccountCreateReceipt(body, account) {
  const created = { ...account, id: '50000000-0000-4000-8000-000000000001', username: body.username, primaryDomain: body.primaryDomain, planId: body.planId,
    ...(Object.hasOwn(body, 'ownerId') ? { ownerId: body.ownerId } : {}), ...(Object.hasOwn(body, 'shell') ? { shell: body.shell } : {}) }
  const checksum = 'd'.repeat(64), cgroup = '/xpanel-' + created.uid + '.slice'
  return {
    account: created,
    operation: { status: 'succeeded', reference: null, resumedFromStep: 0, freshExecution: true, completedReplay: false },
    reconcile: { status: 'applied', generation: { id: 7, checksum, status: 'active' } },
    execution: { status: 'account_verified', scope: 'account', targetVerified: true, verificationRequired: false, observation: {
      accountId: created.id, uid: created.uid, gid: created.gid, home: created.home, revision: 1, generationId: 7, generationChecksum: checksum,
      sourceChecksum: 'b'.repeat(64), cgroup, services: ['nginx.service', 'php-fpm.service'], quota: { enforced: true, filesystem: 'ext4' },
      dns: { zone: created.primaryDomain, serial: 2026110201, authoritative: true }, php: { status: 200, uid: created.uid, cgroup },
    } },
  }
}
