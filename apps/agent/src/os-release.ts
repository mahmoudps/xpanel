/**
 * os-release(5): /etc/os-release takes precedence and /usr/lib/os-release is the fallback.
 * Distributions ship /etc/os-release as a symlink to ../usr/lib/os-release, which the
 * agent's no-follow reader refuses with ELOOP; that refusal means "read the vendor file".
 */
export const readOsRelease = async (reader: { readFile(path: string): Promise<string | null> }): Promise<string | null> => {
  try {
    const text = await reader.readFile('/etc/os-release')
    if (text !== null) return text
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ELOOP') throw error
  }
  return reader.readFile('/usr/lib/os-release')
}
