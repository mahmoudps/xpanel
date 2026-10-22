export const disposableVmAcknowledgement: string
export function executorLinuxPreflight(): {
  layer: 'linux-executor'
  status: 'blocked' | 'available'
  reasons: string[]
}
export function linuxProofPreflight(): {
  layer: 'linux'
  status: 'blocked' | 'available'
  reasons: string[]
}
