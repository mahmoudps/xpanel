import '../i18n.ts'

/** Setup steps both themes show; the addresses and logins they refer to come from the authorized read beside them. */
export interface DavClientGuide { name: string; steps: readonly string[] }

const signIn = msgid('Sign in with the login and password of this Web Disk account.')

export const WEB_DISK_CLIENT_GUIDES: readonly DavClientGuide[] = [
  { name: msgid('Windows'), steps: [msgid('In File Explorer, open This PC and choose Map network drive.'), msgid('Enter the Web Disk address as the folder and select Connect using different credentials.'), signIn] },
  { name: msgid('macOS'), steps: [msgid('In Finder, choose Go, then Connect to Server.'), msgid('Enter the Web Disk address and choose Connect.'), msgid('Select Registered User.'), signIn] },
  { name: msgid('Linux'), steps: [msgid('Open the address bar of your file manager.'), msgid('Enter the Web Disk address with davs:// in place of https://.'), signIn] },
  { name: msgid('Phones and tablets'), steps: [msgid('Install a file app with WebDAV support.'), msgid('Add a WebDAV server with the Web Disk address.'), signIn] },
]

export const DAV_CLIENT_GUIDES: readonly DavClientGuide[] = [
  { name: msgid('iPhone and iPad'), steps: [msgid('Download the device profile of your login and install it in Settings. To set it up by hand instead, follow the next steps.'), msgid('In Settings, open the Calendar accounts and add an Other account.'), msgid('Choose Add CalDAV Account, or Add CardDAV Account for contacts.'), msgid('Enter the server address, your login and your password.')] },
  { name: msgid('macOS'), steps: [msgid('In Calendar, choose Add Account, then Other CalDAV Account.'), msgid('Choose Manual and enter your login, your password and the server address.'), msgid('For contacts, do the same in Contacts with Other CardDAV Account.')] },
  { name: msgid('Thunderbird'), steps: [msgid('In the calendar, choose New Calendar, then On the Network.'), msgid('Enter your login and the server address, then choose Find Calendars.'), msgid('For contacts, choose New Address Book, then Add CardDAV Address Book, and enter the address book URL.')] },
  { name: msgid('Android'), steps: [msgid('Install DAVx5 from your app store.'), msgid('Add an account with your email address: the app finds the server from your domain. If it does not, use the next steps.'), msgid('Add an account with URL and user name.'), msgid('Enter the principal URL, your login and your password, then choose the collections to sync.')] },
  { name: msgid('Outlook'), steps: [msgid('Outlook has no built-in CalDAV or CardDAV support.'), msgid('Use a third-party sync add-in and give it the direct calendar and address book URLs.')] },
]
