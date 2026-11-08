import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultSignInPolicy, SIGN_IN_POLICY_FILE, type SignInPolicy } from '../sign-in-policy.ts'

/** Saves a sign-in policy file the way the API writes it, before the API reads it. */
export async function writeSignInPolicy(rootDir: string, change: (policy: SignInPolicy) => void): Promise<void> {
  const policy = defaultSignInPolicy()
  change(policy)
  await mkdir(join(rootDir, 'extended', 'panel'), { recursive: true })
  await writeFile(join(rootDir, 'extended', 'panel', SIGN_IN_POLICY_FILE), JSON.stringify({ version: 1, ...policy, updatedAt: new Date().toISOString() }))
}

/** The same failure limit for usernames and addresses. */
export const writeSignInLockout = (rootDir: string, attempts: number, minutes = 15): Promise<void> => writeSignInPolicy(rootDir, policy => {
  policy.lockout.username = { attempts, windowMin: minutes, durationMin: minutes }
  policy.lockout.ip = { attempts, windowMin: minutes, durationMin: minutes }
})
