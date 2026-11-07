/** Hooks of an FTP row's Delete button: a login with other services loses FTP only, a login with none is deleted. */
export const ftpRemovalHooks = (user: { id: string; services: { email: boolean; ftp: boolean; webdisk: boolean } }): Record<string, string> => {
  const keep = { ...user.services, ftp: false }
  return { 'data-ftp-remove': user.id, ...(keep.email || keep.webdisk ? { 'data-ftp-remove-keep': JSON.stringify(keep) } : {}) }
}
