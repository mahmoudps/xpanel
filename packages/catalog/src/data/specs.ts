// Origin: public-docs research pass of 2026-10-22 (docs.cpanel.net, api.docs.cpanel.net, aapanel.com/docs),
// described in our own words. Maintained by hand from here on.
import type { ToolSpec } from '../types.ts'

export const specs: ToolSpec[] = [
  {
    "id": "file-manager",
    "behaviors": [
      "Preferences: default start folder (home, web root, public_ftp, or a chosen domain's document root), show dotfiles toggle, and a toggle that silences the encoding-check prompt",
      "Create empty file or folder at a given path",
      "Copy and move one or many items to a destination path; moving also by drag and drop; copying into the same folder is refused",
      "Inline rename of a file, archive or folder",
      "Permissions dialog with owner/group/world read-write-execute checkboxes mirrored to an octal field; new files default to 0644",
      "Upload by drag and drop or file picker into the current folder, with an overwrite option; folders cannot be uploaded directly (create the folder, or upload an archive and extract it)",
      "Download a single file to the browser",
      "View file contents read-only",
      "Compress the selection into one .zip, .gz or .bz2 archive at a chosen path; extract those formats into a chosen folder with progress",
      "Folder shortcuts into Directory Privacy, leech protection and directory index settings when those tools are enabled",
      "Delete sends items to the account trash, not a hard delete",
      "Search by file name with scope: whole home, only public_html, or current folder; double-click a hit opens it or its folder; empty result shows a no-match message",
      "Single-item actions (rename, edit, view) act on the first selected item when several are selected; unavailable actions are greyed out",
      "Warns against changing files inside a Git working tree that the panel manages"
    ],
    "acceptance": "An upload or move whose resolved target (including via a symlink) lies outside the account home is rejected with PATH_OUTSIDE_HOME and nothing is written; a normal upload lands owned by the account UID with mode 0644, and re-uploading the same name without overwrite=1 fails with ALREADY_EXISTS.",
    "source": "https://docs.cpanel.net/cpanel/files/file-manager/",
    "upstreamFeatureKey": "filemanager",
    "upstreamAcl": "",
    "upstreamApi": "Fileman (list_files, upload_files, copy_file, move_file, rename_file, get_file_information, get_file_content, autocompletedir); ExtractInfo (start, progress, finish)",
    "absorbed": [
      {
        "id": "aapanel-file-browser",
        "name": "File Browser",
        "source": "https://www.aapanel.com/docs/Function/Files.html",
        "behaviors": [
          "Columns for name, protection, permissions and owner, size, modified time and description; sort by name, size or time",
          "Calculate directory sizes on demand",
          "Editable path bar, and a jump to the root directory with free space shown"
        ]
      },
      {
        "id": "aapanel-file-transfer-in",
        "name": "Upload and Remote Download",
        "source": "https://www.aapanel.com/docs/Function/Files.html",
        "behaviors": [
          "Upload files or whole folders",
          "Fetch a remote URL into a chosen directory"
        ]
      },
      {
        "id": "aapanel-file-operations",
        "name": "File Operations",
        "source": "https://www.aapanel.com/docs/Function/Files.html",
        "behaviors": [
          "New file, directory or symbolic link",
          "Copy, cut and paste, with keyboard shortcuts; rename",
          "Compress and extract archives; delete goes to the recycle bin by default"
        ]
      },
      {
        "id": "aapanel-file-permissions",
        "name": "Permissions and Ownership",
        "source": "https://www.aapanel.com/docs/Function/Files.html",
        "behaviors": [
          "Mode and owner, with an 'apply to subdirectories' option",
          "Defaults: 755 for directories, 644 for files, web user as owner",
          "Back up permissions so they can be restored later"
        ]
      },
      {
        "id": "aapanel-file-content-search",
        "name": "Search File Contents",
        "source": "https://www.aapanel.com/docs/Function/Files.html",
        "behaviors": [
          "Search text, extension filter and starting directory"
        ]
      },
      {
        "id": "aapanel-file-favorites",
        "name": "Path Favorites",
        "source": "https://www.aapanel.com/docs/Function/Files.html",
        "behaviors": [
          "Add or remove a bookmark (a pointer to the path, not a copy)"
        ]
      }
    ]
  },
  {
    "id": "file-trash",
    "behaviors": [
      "Delete from File Manager moves the item into a hidden trash folder in the home and records where it came from",
      "View trash lists trashed items with original path and deletion time",
      "Restore puts the most recent trashed copy of a path back at its original location; fails if something already exists there",
      "Empty trash permanently removes all items, or only items older than N days",
      "Shows trash size and item count, and counts toward the account disk quota",
      "Permanent delete of a single trashed item"
    ],
    "acceptance": "Deleting public_html/a.txt moves it into the trash and restoring it returns identical bytes to public_html/a.txt; restoring while public_html/a.txt already exists fails with TARGET_EXISTS and leaves both copies untouched.",
    "source": "https://api.docs.cpanel.net/specifications/cpanel.openapi/manage-files/fileman-trash_file.md",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Fileman::trash_file, Fileman::restore_from_trash, Fileman::empty_trash (older_than), Trash::usage, Trash::remove",
    "absorbed": [
      {
        "id": "aapanel-recycle-bin",
        "name": "Recycle Bin",
        "source": "https://www.aapanel.com/docs/Function/Files.html",
        "behaviors": [
          "File bin on by default; deleted site roots go here",
          "Database bin (MySQL) off by default; deleting a database only marks it",
          "Columns: name, original path, size, deleted time",
          "Recover, delete permanently, empty all"
        ]
      }
    ]
  },
  {
    "id": "file-text-editor",
    "behaviors": [
      "Before editing, asks which character encoding the file uses (can be disabled in preferences) and warns that a wrong choice may corrupt the file",
      "Files larger than 1 MB are not editable in the browser; the user must download them",
      "Saves content transcoded from the editor encoding into the target encoding, with optional fallback to the default encoding or a hard error",
      "Saving an absent file creates an empty one"
    ],
    "acceptance": "Opening a file over 1 MB for editing returns FILE_TOO_LARGE; saving text with to_charset=ISO-8859-1 and fallback=0 writes single-byte encoded bytes, and a character not representable in that charset fails with ENCODING_ERROR without modifying the file.",
    "source": "https://docs.cpanel.net/cpanel/files/file-manager/",
    "upstreamFeatureKey": "filemanager",
    "upstreamAcl": "",
    "upstreamApi": "Fileman::get_file_content, Fileman::save_file_content (from_charset, to_charset, fallback), Fileman::transcode",
    "absorbed": [
      {
        "id": "aapanel-file-editor",
        "name": "Online File Editor",
        "source": "https://www.aapanel.com/docs/Function/Files.html",
        "behaviors": [
          "Syntax highlighting and hints",
          "Save, keeping earlier versions that can be restored"
        ]
      }
    ]
  },
  {
    "id": "html-editor",
    "behaviors": [
      "Save to server, undo and redo",
      "Inline text styling (bold, italic, underline, strike, super/subscript, clear and copy formatting), font family, size, color, block format and line height",
      "Lists, horizontal rule, alignment and indentation",
      "Clipboard cut/copy/paste and select all",
      "Insert image (upload or URL), embedded video, file link, table and hyperlink; remove link",
      "Find and replace; switch between visual and HTML source modes",
      "Does not run page JavaScript while editing, so scripted parts may look different from the live site"
    ],
    "acceptance": "Editing a heading in visual mode and saving writes the changed markup to the same path while keeping the file owner and mode unchanged; a <script> block present in the file survives the round trip byte-for-byte and is never executed inside the editor.",
    "source": "https://docs.cpanel.net/cpanel/files/html-editor/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Fileman::get_file_content, Fileman::save_file_content",
    "absorbed": []
  },
  {
    "id": "images",
    "behaviors": [
      "Thumbnailer: pick a folder and width/height percentages (optionally locked to aspect ratio); writes shrunken copies into a thumbnails subfolder with a tn_ name prefix and links the result in File Manager",
      "Thumbnailer works per folder only, not per single file",
      "Scaler: resize one image by pixel dimensions or percentage, with aspect-ratio lock, reset, and an option to keep the original under another path",
      "Converter: convert one image or every image in a folder to PNG, JPG, GIF, BMP or WEBP; output is written beside the source",
      "Read current pixel dimensions of an image"
    ],
    "acceptance": "Running the thumbnailer at 50%/50% on a folder holding a.png (400x200) creates thumbnails/tn_a.png sized 200x100 owned by the account UID, and the original a.png is unchanged.",
    "source": "https://docs.cpanel.net/cpanel/files/images/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "ImageManager (create_thumbnails, resize_image, convert_file, get_dimensions)",
    "absorbed": []
  },
  {
    "id": "directory-privacy",
    "behaviors": [
      "Browse the home tree; folders that already have protection are marked",
      "Enable or disable protection for a folder with a realm label shown in the login prompt",
      "Protection is inherited by subfolders",
      "Add an authorized user with password (strength meter 0-100, generator, host minimum); re-adding an existing user changes the password",
      "List and delete authorized users",
      "Only web (HTTP) access is protected; FTP, WebDAV and local access are not affected",
      "Hint to set folder mode 0700 if user creation fails because of permissions"
    ],
    "acceptance": "After protecting public_html/private and adding user u1, GET /private/ returns 401 without credentials and 200 with u1's password; deleting u1 makes the same request return 401, and the password file is stored outside every document root.",
    "source": "https://docs.cpanel.net/cpanel/files/directory-privacy/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "DirectoryPrivacy (configure_directory_protection, is_directory_protected, list_directories, add_user, delete_user, list_users)",
    "absorbed": [
      {
        "id": "aapanel-dir-password",
        "name": "Directory Password Protection",
        "source": "https://www.aapanel.com/docs/Function/php.html",
        "behaviors": [
          "Fields: name, directory, username, password",
          "Several protected directories per site",
          "HTTP basic authentication"
        ]
      }
    ]
  },
  {
    "id": "disk-usage",
    "behaviors": [
      "Bar per directory scaled to the largest directory",
      "Separate rows for hidden subfolders, mailing lists, files outside home, and MySQL/PostgreSQL databases (databases count toward usage)",
      "Link from a directory into File Manager at that path",
      "Shows quota used vs. limit and warns when writes will fail at the limit",
      "Explains that block allocation makes usage exceed raw byte totals and that figures may lag recent changes (cached)"
    ],
    "acceptance": "After writing a 50 MB file to public_html and refreshing the usage cache, the public_html row grows by 50 MB (±1 MB block rounding) and total used equals home + mail + databases within 1%.",
    "source": "https://docs.cpanel.net/cpanel/files/disk-usage/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Quota::get_quota_info, Quota::get_local_quota_info; API2 DiskUsage::fetchdiskusagewithextras, buildcache, clearcache",
    "absorbed": []
  },
  {
    "id": "web-disk",
    "behaviors": [
      "Main Web Disk account uses the panel login, points at home, and cannot be deleted",
      "Create extra account: username, domain, password (min 5 chars, strength meter), top folder relative to home (defaults under public_html), read-write or read-only",
      "Optional digest authentication for clients that need it on non-TLS connections; recommended to use TLS instead",
      "Per account: change password, change folder, toggle read-only/read-write, enable digest, delete (optionally deleting its folder)",
      "Configure client access: show connection details and offer per-OS setup files",
      "Account login does not open the control panel",
      "Renaming user or domain invalidates the digest secret, which must be re-enabled"
    ],
    "acceptance": "A read-only Web Disk account gets a 207 multistatus on PROPFIND of its folder but 403 on PUT, cannot PROPFIND a path above its folder (403/404), and deleting it with destroy=0 leaves its folder contents intact.",
    "source": "https://docs.cpanel.net/cpanel/files/web-disk/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "WebDisk (set_homedir, set_password, set_permissions, delete_user); API2 WebDisk (addwebdisk, listwebdisks, passwdwebdisk, set_digest_auth, hasdigest, set_perms, delwebdisk)",
    "absorbed": []
  },
  {
    "id": "ftp-accounts",
    "behaviors": [
      "Create: login, domain, password with strength meter and generator, folder relative to home (default derived from the login), quota in MB or unlimited",
      "Login is user@domain; symlinks cannot be used to escape the jail",
      "List accounts with type (main, extra, log-access, anonymous), folder, usage and quota",
      "Change password, change quota, change folder",
      "Delete account only, or account plus its folder (with a strong warning when the folder is or contains public_html)",
      "Built-in system accounts (main account with full home access, raw-log download account) are listed but cannot be edited or deleted",
      "Client configuration: server host and port; advise SFTP and that FTPS should use the server hostname because FTP has no SNI",
      "Counts against the plan's FTP account limit"
    ],
    "acceptance": "Creating an FTP account with homedir '../x' is rejected with PATH_OUTSIDE_HOME; a valid account logged in over FTP sees only its folder as '/', and creating one more account than the plan's FTP limit returns LIMIT_EXCEEDED.",
    "source": "https://docs.cpanel.net/cpanel/files/ftp-accounts/",
    "upstreamFeatureKey": "ftpaccts",
    "upstreamAcl": "",
    "upstreamApi": "Ftp (add_ftp, list_ftp, list_ftp_with_disk, passwd, set_quota, set_homedir, delete_ftp, ftp_exists, get_quota, get_port, server_name)",
    "absorbed": [
      {
        "id": "aapanel-ftp-accounts",
        "name": "FTP Accounts",
        "source": "https://www.aapanel.com/docs/Function/Ftp.html",
        "behaviors": [
          "Add an account with username, password and home directory",
          "List accounts with status and notes; enable or disable, view or change the password, delete"
        ]
      },
      {
        "id": "aapanel-ftp-quota",
        "name": "FTP Quota",
        "source": "https://www.aapanel.com/docs/Function/Ftp.html",
        "behaviors": [
          "View and set a size limit per account",
          "Refuse when the filesystem does not support quotas"
        ]
      },
      {
        "id": "aapanel-ftp-home-path",
        "name": "Change FTP Home Directory",
        "source": "https://www.aapanel.com/docs/Function/Ftp.html",
        "behaviors": [
          "Set a new home directory",
          "Optionally copy the data across while keeping the old data"
        ]
      }
    ]
  },
  {
    "id": "ftp-connections",
    "behaviors": [
      "Table of sessions: FTP user, client host, login time, state (e.g. idle or transferring), process id",
      "Disconnect one session, or all sessions of the account",
      "Reload to refresh the list"
    ],
    "acceptance": "With one open FTP session for ftpuser@example.test, the list shows its PID; Disconnect closes the TCP connection within 5 seconds and the next reload no longer lists that PID, while sessions of other accounts are untouched.",
    "source": "https://docs.cpanel.net/cpanel/files/ftp-connections/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Ftp::list_sessions, Ftp::kill_session (login or all)",
    "absorbed": []
  },
  {
    "id": "anonymous-ftp",
    "behaviors": [
      "Shown only when the server enables FTP and anonymous FTP",
      "Checkbox to allow anonymous downloads and a separate one to allow anonymous uploads (uploads strongly discouraged)",
      "Edit the welcome banner shown at login",
      "Anonymous users must log in with the domain in the username so they reach the right public_ftp"
    ],
    "acceptance": "With anonymous access off, login as anonymous@example.test fails with FTP 530; turning it on allows listing public_ftp, and with uploads off a STOR returns 550 while nothing appears on disk.",
    "source": "https://docs.cpanel.net/cpanel/files/anonymous-ftp/",
    "upstreamFeatureKey": "ftpaccts",
    "upstreamAcl": "",
    "upstreamApi": "Ftp (allows_anonymous_ftp, set_anonymous_ftp, allows_anonymous_ftp_incoming, set_anonymous_ftp_incoming, get_welcome_message, set_welcome_message)",
    "absorbed": []
  },
  {
    "id": "backup",
    "behaviors": [
      "Full backup destinations: home folder, remote FTP (active or passive, port), remote SCP (password or key); remote host, user, path fields",
      "Optional email when the full backup finishes, or no notification",
      "List and download full backups already in home (date-stamped .tar.gz)",
      "Full backups cannot be restored from the user panel; only the admin side restores them",
      "Partial downloads: home directory archive, each MySQL database dump, email forwarders per domain, account-level email filters",
      "Partial restore: upload a home archive, database dump, forwarders file or filters file and restore it",
      "User-defined exclude list file in home to skip paths in the home archive",
      "Backups may fail when the account is at its disk quota"
    ],
    "acceptance": "A full backup to home produces one .tar.gz containing the home files, a dump per database and mail, readable with tar -tzf; when the account is already at quota the job fails with QUOTA_EXCEEDED and leaves no partial archive.",
    "source": "https://docs.cpanel.net/cpanel/files/backup-for-cpanel/",
    "upstreamFeatureKey": "backup",
    "upstreamAcl": "",
    "upstreamApi": "Backup (fullbackup_to_homedir, fullbackup_to_ftp, fullbackup_to_scp_with_key, fullbackup_to_scp_with_password, list_backups, restore_files, restore_databases, restore_email_forwarders, restore_email_filters); BackupInfo (list, progress, reset)",
    "absorbed": [
      {
        "id": "backup-wizard",
        "name": "Backup Wizard",
        "source": "https://docs.cpanel.net/cpanel/files/backup-wizard/",
        "behaviors": [
          "Back up path: choose full (pick destination and notification) or partial (home, databases, forwarders and filters) and download the result",
          "Restore path: choose the part type, upload a matching file, start restore",
          "Only partial backups are restorable here",
          "Explains manual recovery of public_html from a full archive"
        ]
      },
      {
        "id": "aapanel-db-backup-restore",
        "name": "Database Backup and Restore",
        "source": "https://www.aapanel.com/docs/Function/MySQL.html",
        "behaviors": [
          "Back up now",
          "Restore from a backup, overwriting the current data",
          "Download or delete backups"
        ]
      }
    ]
  },
  {
    "id": "website-backups",
    "behaviors": [
      "Pre-check whether a backup of a domain fits the remaining quota",
      "Start a backup for a domain with optional databases and completion email; returns an operation id",
      "Poll operation progress; recover running operations after page reload",
      "List backups covering a domain, newest first",
      "Restore in place: merge (overwrite and add, keep newer files) or clean snapshot; databases restored by default with rollback snapshot on failure",
      "Extract a backup's files into a new folder without touching the live site",
      "Delete one or several backups",
      "Only one backup/restore runs per account at a time; jobs have a wall-clock cap"
    ],
    "acceptance": "Starting a second website backup while one is still running for the same account returns OPERATION_IN_PROGRESS; a clean restore removes a file created after the backup while a merge restore keeps it.",
    "source": "https://api.docs.cpanel.net/specifications/cpanel.openapi/websitebackup/websitebackup-create_backup.md",
    "upstreamFeatureKey": "backup",
    "upstreamAcl": "",
    "upstreamApi": "WebsiteBackup (disk_quota_check, create_backup, operation_status, list_operations, list_backups, restore_backup, extract_backup, delete_backup)",
    "absorbed": [
      {
        "id": "aapanel-site-backup",
        "name": "Site Backup",
        "source": "https://www.aapanel.com/docs/SubaaPanel/Website.html",
        "behaviors": [
          "On-demand backup",
          "List: file name and path, size, time",
          "Restore, download, delete"
        ]
      }
    ]
  },
  {
    "id": "git-version-control",
    "behaviors": [
      "Create: clone toggle with remote URL (http, https, ssh, git or scp-style; no embedded credentials, no local paths), repository path, display name, create-another option",
      "Path must be empty unless registering an existing repo; disallowed characters and reserved system folders are rejected",
      "SSH remotes: show the remote host key fingerprints and require approval before saving to known_hosts; warn loudly when a known key changed",
      "List repositories with name and path; actions Manage, History, Remove from list (files kept)",
      "Manage: open path in File Manager, rename display name, switch checked-out branch (pulls), show HEAD commit hash, author, date, message, remote URL and a copyable clone URL",
      "Update from Remote does fast-forward-only pulls",
      "Deploy HEAD Commit runs the tasks listed in a deployment file at repo root; needs at least one branch and a clean working tree; shows last deployment info",
      "Push to the managed repo triggers deployment automatically through a post-receive hook",
      "Public web access to .git folders is blocked"
    ],
    "acceptance": "Creating a repo with clone URL https://u:p@git.test/r.git is rejected with INVALID_CLONE_URL; with a dirty working tree, Deploy HEAD Commit fails with DEPLOY_DIRTY_TREE and runs no tasks; with a clean tree it runs the listed tasks in order as the account UID and records the deployed commit hash.",
    "source": "https://docs.cpanel.net/cpanel/files/git-version-control/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "VersionControl (create, retrieve, update, delete); VersionControlDeployment (create, retrieve, delete); KnownHosts (verify, create, update, delete)",
    "absorbed": [
      {
        "id": "aapanel-site-from-git",
        "name": "Create Site from Git",
        "source": "https://www.aapanel.com/docs/Function/php.html",
        "behaviors": [
          "Shows the server deploy public key to add at the Git host",
          "Fields: provider, repository, branch, PHP version, domain, path",
          "Clone into the root; later pull to redeploy"
        ]
      }
    ]
  },
  {
    "id": "gitweb",
    "behaviors": [
      "Summary, log, short log, commit, commit diff (inline, side by side, raw), tree, blob with line numbers and raw view, file history, heads and tags",
      "Branch markers for local branches, remote branches and tags",
      "Snapshot and patch downloads; Atom/RSS feeds where applicable",
      "Search by commit message, author, committer, content grep and pickaxe, with optional regex",
      "No write operations"
    ],
    "acceptance": "The history view of a managed repo lists commits newest first with hashes matching git log; requesting the viewer for a path outside the account or not managed by the panel returns 404 and no mutating HTTP method is accepted (405).",
    "source": "https://docs.cpanel.net/cpanel/files/gitweb/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "file-restoration",
    "behaviors": [
      "Two ways to pick an item: type a path relative to home, or browse folders",
      "Show backups available for the item (daily, weekly, monthly, incremental) and restore the chosen one after confirmation",
      "Restore puts the item at its original path; deleted items come back and existing ones are overwritten",
      "Only backups on local storage are usable; remote ones must first be brought local",
      "Panel config and mail folders are excluded and need a full account restore",
      "Available only when the admin has account backups enabled"
    ],
    "acceptance": "Restoring public_html/index.php from backup point D replaces the current file with the bytes stored in D and owner stays the account UID; a restore request for a path under mail/ returns PATH_NOT_RESTORABLE.",
    "source": "https://docs.cpanel.net/cpanel/files/file-and-directory-restoration-for-cpanel/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "file-restore",
    "upstreamApi": "Restore (directory_listing, query_file_info, restore_file); Backup::list_backups",
    "absorbed": []
  },
  {
    "id": "phpmyadmin",
    "behaviors": [
      "One-click login without retyping a password, using a short-lived session user",
      "Browse, insert, edit and delete rows; run SQL; import and export",
      "Only the account's databases are visible",
      "Databases and users should be created in the panel, not in phpMyAdmin, so they stay mapped for backups",
      "On MySQL 8+, displayed table statistics can lag because of server-side stats caching"
    ],
    "acceptance": "Opening phpMyAdmin from account A creates a session that lists only A's databases; a SELECT on a database owned by account B fails with MySQL error 1044/1142, and the temporary session user is gone after logout or expiry.",
    "source": "https://docs.cpanel.net/cpanel/databases/phpmyadmin/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Session::create_temp_user",
    "absorbed": []
  },
  {
    "id": "mysql-databases",
    "behaviors": [
      "Create database; account prefix (username_) added automatically when prefixing is on",
      "Name limit 64 characters with each underscore counted as two; prefix counts",
      "Show remote database host address when the server uses a remote DB server",
      "Check a database for corrupt tables and report the bad table or success",
      "Repair a database and report the result",
      "Table of databases with size and privileged users; revoke a user from a database; open privilege editor per user",
      "Rename a database (implemented as create new, copy data, recreate grants and stored code, drop old; terminates connections; tries to roll back on failure)",
      "Delete a database permanently after confirmation",
      "Counts against the plan's database limit"
    ],
    "acceptance": "Creating a database whose prefixed name exceeds 64 characters (underscores counted twice) fails with NAME_TOO_LONG; creating one more than the plan's database limit fails with LIMIT_EXCEEDED; renaming db1 to db2 preserves row counts and grants and leaves db1 absent.",
    "source": "https://docs.cpanel.net/cpanel/databases/manage-my-databases/",
    "upstreamFeatureKey": "mysql",
    "upstreamAcl": "",
    "upstreamApi": "Mysql (create_database, list_databases, check_database, repair_database, rename_database, delete_database, get_restrictions, get_server_information, locate_server, dump_database_schema)",
    "absorbed": [
      {
        "id": "aapanel-db-recycle-bin",
        "name": "Database Recycle Bin",
        "source": "https://www.aapanel.com/docs/Function/Files.html",
        "behaviors": [
          "Toggle the database recycle bin",
          "Recover or permanently delete marked databases"
        ]
      },
      {
        "id": "aapanel-mysql-databases",
        "name": "MySQL Databases",
        "source": "https://www.aapanel.com/docs/Function/MySQL.html",
        "behaviors": [
          "Fields: name, character set, username, password, access scope, target server, and force SSL",
          "List view showing the password (copy), quota, backup count and notes",
          "Bulk sync, backup and delete"
        ]
      },
      {
        "id": "aapanel-db-import",
        "name": "Database Import",
        "source": "https://www.aapanel.com/docs/Function/MySQL.html",
        "behaviors": [
          "Upload a dump",
          "Import it into the selected database",
          "Delete uploaded files"
        ]
      }
    ]
  },
  {
    "id": "mysql-users",
    "behaviors": [
      "Create user with password (strength meter, generator, host minimum); stored password is never shown again",
      "Username length cap depends on engine and includes the prefix (MariaDB 47, MySQL 5.7+ 32)",
      "Add a user to a database, then tick individual privileges or ALL PRIVILEGES",
      "Privilege set: ALTER, ALTER ROUTINE, CREATE, CREATE ROUTINE, CREATE TEMPORARY TABLES, CREATE VIEW, DELETE, DROP, EVENT, EXECUTE, INDEX, INSERT, LOCK TABLES, REFERENCES, SELECT, SHOW VIEW, TRIGGER, UPDATE; saving replaces the previous set",
      "Change password, rename, delete user",
      "Users are separate from mail and panel logins"
    ],
    "acceptance": "Granting user u only SELECT on db makes SHOW GRANTS list exactly SELECT on that database; an INSERT by u then fails with error 1142, and a username longer than the engine limit including prefix is rejected with NAME_TOO_LONG.",
    "source": "https://docs.cpanel.net/cpanel/databases/manage-my-databases/",
    "upstreamFeatureKey": "mysql",
    "upstreamAcl": "",
    "upstreamApi": "Mysql (create_user, list_users, set_password, rename_user, delete_user, set_privileges_on_database, get_privileges_on_database, revoke_access_to_database, update_privileges, list_routines)",
    "absorbed": []
  },
  {
    "id": "database-wizard",
    "behaviors": [
      "Step 1: database name (64-char limit, underscore counts double, no slash, quotes or backtick)",
      "Step 2: alphanumeric username and password with strength meter and generator",
      "Step 3: pick privileges or all privileges; the grant is applied automatically",
      "Step 4: success screen with options to add another database, add another user, or go back"
    ],
    "acceptance": "Finishing the wizard with name 'shop', user 'app' and ALL PRIVILEGES yields database <prefix>shop, user <prefix>app and a grant visible in SHOW GRANTS; a name containing a backtick is rejected at step 1 with INVALID_NAME and nothing is created.",
    "source": "https://docs.cpanel.net/cpanel/databases/database-wizard/",
    "upstreamFeatureKey": "mysql",
    "upstreamAcl": "",
    "upstreamApi": "Mysql (create_database, create_user, set_privileges_on_database)",
    "absorbed": []
  },
  {
    "id": "remote-database-access",
    "behaviors": [
      "Add host as hostname, IPv4, IPv6, % wildcard pattern or CIDR range",
      "Optional note up to 255 ASCII characters; edit the note later",
      "List hosts and remove a host after confirmation, which revokes its access",
      "Hosts added by the server administrator may appear and cannot be removed by the user"
    ],
    "acceptance": "Adding 203.0.113.0/24 lets a client at 203.0.113.7 authenticate as the account's DB user while 198.51.100.7 is refused; removing the entry makes the next connection from 203.0.113.7 fail, and a note longer than 255 characters is rejected with INVALID_NOTE.",
    "source": "https://docs.cpanel.net/cpanel/databases/remote-database-access/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Mysql (add_host, delete_host, add_host_note, get_host_notes)",
    "absorbed": [
      {
        "id": "aapanel-db-access-permission",
        "name": "Database Access Scope",
        "source": "https://www.aapanel.com/docs/Function/MySQL.html",
        "behaviors": [
          "Local, everyone, or a specified IP list",
          "Force SSL toggle"
        ]
      }
    ]
  },
  {
    "id": "postgresql-databases",
    "behaviors": [
      "Create database; name up to 63 characters including any prefix",
      "Table of databases with size and privileged users; remove a user from a database",
      "Rename database (drops active connections) and delete database",
      "Create user (63-char cap, password at least 5 chars, strength meter)",
      "Add user to database grants full access",
      "Change password; rename user forces a password reset because the stored hash depends on the name; delete user",
      "Synchronize Grants re-applies privileges on all existing tables, needed after tables are created outside the panel"
    ],
    "acceptance": "After user u is linked to database d and a table t is created by another linked role, u cannot SELECT from t until Synchronize Grants runs, after which the SELECT succeeds; renaming u without a new password leaves u unable to log in until a password is set.",
    "source": "https://docs.cpanel.net/cpanel/databases/postgresql-databases/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Postgresql (create_database, list_databases, rename_database, delete_database, get_restrictions, create_user, list_users, set_password, rename_user, rename_user_no_password, delete_user, grant_all_privileges, revoke_all_privileges, update_privileges)",
    "absorbed": [
      {
        "id": "aapanel-postgresql",
        "name": "PostgreSQL Databases",
        "source": "https://www.aapanel.com/docs/Function/PgSQL.html",
        "behaviors": [
          "Add a database with a user, change the password, delete",
          "Backup, restore and import",
          "Sync the inventory and run bulk actions"
        ]
      }
    ]
  },
  {
    "id": "postgresql-database-wizard",
    "behaviors": [
      "Step 1: database name (63-char cap with prefix)",
      "Step 2: username and password with strength meter",
      "Step 3: confirm user and database pairing; access granted automatically",
      "Finish with options to add another database or user, or return home"
    ],
    "acceptance": "Completing the wizard creates <prefix>d and <prefix>u, and u can connect to d over localhost and create a table there; u cannot connect to any database of another account.",
    "source": "https://docs.cpanel.net/cpanel/databases/postgresql-database-wizard/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Postgresql (create_database, create_user, grant_all_privileges)",
    "absorbed": []
  },
  {
    "id": "phppgadmin",
    "behaviors": [
      "Open a web SQL client for PostgreSQL scoped to the account's databases",
      "Browse and edit rows, run SQL",
      "Databases and users must still be created in the panel"
    ],
    "acceptance": "The PostgreSQL web client opened from account A lists only A's databases, and connecting to a database of account B fails with a permission error.",
    "source": "https://docs.cpanel.net/cpanel/databases/phppgadmin/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "mysql-manager",
    "behaviors": [
      "Sortable database list by name, size and users",
      "Create database with optional auto-created user given SELECT, INSERT, UPDATE, DELETE",
      "Rename and delete database"
    ],
    "acceptance": "Not built; its capabilities are covered by mysql-databases and mysql-users.",
    "source": "https://docs.cpanel.net/cpanel/databases/mysql-manager/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Mysql",
    "absorbed": []
  },
  {
    "id": "domains",
    "behaviors": [
      "Sortable list: domain (main domain flagged), document root (links to File Manager), redirect target",
      "Per-row actions: Manage, and create email for that domain",
      "Option to reveal the system-generated subdomains that back addon domains",
      "Create a New Domain button showing remaining plan allowances",
      "Main domain can only be changed by the admin side"
    ],
    "acceptance": "For an account with one main, one addon, one subdomain and one alias, the list returns exactly four user-visible entries with correct type and document root, and hides the addon's backing subdomain unless the reveal option is set.",
    "source": "https://docs.cpanel.net/cpanel/domains/domains/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "DomainInfo (list_domains, domains_data, single_domain_data, primary_domain); DomainLookup (getdocroots, getbasedomains)",
    "absorbed": [
      {
        "id": "addon-domains",
        "name": "Addon Domains",
        "source": "https://api.docs.cpanel.net/specifications/cpanel.openapi/addondomain/addondomain-addaddondomain.md",
        "behaviors": [
          "Create with new domain, backing subdomain label and document root (default under public_html)",
          "No wildcard addon domains; the main domain may not be a subdomain of the addon",
          "Creation is atomic: if parking fails the backing subdomain is removed",
          "Also creates an FTP account for the domain that counts against the FTP limit",
          "List addon domains; remove one (backing subdomain removed unless other domains still park on it; files kept)"
        ]
      },
      {
        "id": "subdomains",
        "name": "Subdomains",
        "source": "https://api.docs.cpanel.net/specifications/cpanel.openapi/subdomain/subdomain-addsubdomain.md",
        "behaviors": [
          "Create label on a chosen parent domain with a document root",
          "Labels validated by a published pattern; system-reserved labels refused",
          "Change document root of a subdomain (target folder must already exist; files not moved)",
          "Remove subdomain; refused while an addon domain is parked on it; files kept",
          "Counts against the plan's subdomain limit"
        ]
      },
      {
        "id": "aliases",
        "name": "Alias Domains",
        "source": "https://api.docs.cpanel.net/specifications/cpanel.openapi/park/park-park.md",
        "behaviors": [
          "Park a domain on the main domain (or on a subdomain, which is how addon domains work)",
          "Domain is lowercased and a leading www. stripped before validation",
          "List and remove aliases",
          "No Force HTTPS toggle for aliases; redirect can be set via Redirects",
          "Counts against the plan's alias limit"
        ]
      },
      {
        "id": "aapanel-site-categories",
        "name": "Site Categories",
        "source": "https://www.aapanel.com/docs/Function/php.html",
        "behaviors": [
          "Add, rename and delete categories",
          "Assign via Set category"
        ]
      },
      {
        "id": "aapanel-site-domains",
        "name": "Domain Manager",
        "source": "https://www.aapanel.com/docs/Function/php.html",
        "behaviors": [
          "Add domain or domain:port, wildcards allowed",
          "Refuses domains bound to another site",
          "Delete; the last domain cannot be removed"
        ]
      }
    ]
  },
  {
    "id": "force-https-redirect",
    "behaviors": [
      "On/off switch per domain row",
      "Bulk on/off for selected domains",
      "Only available when a valid certificate covers the domain; not offered for aliases"
    ],
    "acceptance": "With the toggle on, GET http://example.test/a?b=1 returns 301 to https://example.test/a?b=1; enabling it for a domain without a valid certificate returns CERT_REQUIRED and the vhost config is unchanged.",
    "source": "https://docs.cpanel.net/cpanel/domains/domains/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "create-domain",
    "behaviors": [
      "Choose registered domain, temporary domain, or (if enabled) purchase",
      "Domain field takes an FQDN; a name under an existing account domain becomes a subdomain",
      "Share document root with the main domain checkbox (permanent) creates an alias",
      "Own document root field, auto-filled and editable, must stay inside public_html and avoid reserved folders",
      "Submit, or submit and create another",
      "New addon/subdomain gets PHP error logging to a per-account log",
      "Tries an existing certificate, else self-signed, then requests an automatic certificate when allowed",
      "Rejected when the plan limit for that domain type is reached"
    ],
    "acceptance": "Creating an addon domain beyond the plan's addon limit is rejected with LIMIT_EXCEEDED; a document root of '../outside' or 'public_html/../etc' is rejected with DOCROOT_INVALID; a valid addon domain answers HTTP on its own vhost within one reconcile cycle.",
    "source": "https://docs.cpanel.net/cpanel/domains/domains/create-a-new-domain/",
    "upstreamFeatureKey": "addondomains",
    "upstreamAcl": "",
    "upstreamApi": "AddonDomain::addaddondomain, SubDomain::addsubdomain, Park::park",
    "absorbed": [
      {
        "id": "temporary-domains",
        "name": "Temporary Domains",
        "source": "https://docs.cpanel.net/cpanel/domains/domains/create-a-new-domain/",
        "behaviors": [
          "Create a temporary hostname from the create-domain flow",
          "No DNS editing, email services or SEO on temporary domains",
          "Can be hidden from domain lists",
          "Convert to a registered domain from Manage the Domain"
        ]
      },
      {
        "id": "aapanel-site-create",
        "name": "Add Site",
        "source": "https://www.aapanel.com/docs/Function/php.html",
        "behaviors": [
          "Domains one per line with optional :port; the www name is not added automatically",
          "Description, document root defaulting to web root plus domain",
          "Optional FTP account and MySQL database",
          "PHP version from installed versions, or static",
          "Category",
          "Optional automatic certificate request"
        ]
      },
      {
        "id": "aapanel-site-batch-create",
        "name": "Batch Site Creation",
        "source": "https://www.aapanel.com/docs/Function/php.html",
        "behaviors": [
          "One site per line, pipe-separated fields",
          "Per-line result with reason",
          "Bad lines do not stop the others"
        ]
      },
      {
        "id": "aapanel-subdir-binding",
        "name": "Subdirectory Binding",
        "source": "https://www.aapanel.com/docs/Function/php.html",
        "behaviors": [
          "Fields: hostname and subdirectory",
          "List and delete bindings"
        ]
      }
    ]
  },
  {
    "id": "manage-domain",
    "behaviors": [
      "Change document root (files are not moved; main domain and shared roots cannot be changed)",
      "Rename main, addon or alias domains (not subdomains); new name must be unused on the server; updates mail, DNS and document root; one rename at a time",
      "Replace a temporary domain with a registered one, unlocking DNS editing and email per plan",
      "Read-only info: domain, redirect target, document root",
      "Remove domain: deletes vhost and DNS only, keeps files; main domain cannot be removed; mailboxes reappear if the domain is re-added",
      "Shortcuts to create email, edit zone and edit redirects"
    ],
    "acceptance": "Removing addon domain shop.test deletes its vhost and DNS zone (Host: shop.test no longer matches) while every file in its document root remains byte-identical; removing the main domain returns MAIN_DOMAIN_PROTECTED.",
    "source": "https://docs.cpanel.net/cpanel/domains/domains/manage-the-domain/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "SubDomain::changedocroot, Domain::rename_domain, Domain::convert_temporary_to_registered, AddonDomain::deladdondomain, SubDomain::delsubdomain, Park::unpark",
    "absorbed": []
  },
  {
    "id": "redirects",
    "behaviors": [
      "Type: permanent or temporary",
      "Source: one domain or all public domains, plus a path",
      "Target URL must include a scheme",
      "www handling: only www, with or without www, or never www (disabled for all-domains)",
      "Wildcard option maps every file under the source path to the same name at the target",
      "List with domain, source path, match pattern, target, status code, type, www match and wildcard; search; delete (no edit, recreate instead)",
      "Rules are stored in the domain's .htaccess; applications that rewrite earlier may override them",
      "Use Force HTTPS rather than a redirect to move HTTP to HTTPS"
    ],
    "acceptance": "A permanent redirect of example.test/old to https://t.test/new makes GET /old return 301 with that Location; with www mode 'only www', a request to example.test/old is not redirected while www.example.test/old is; deleting the rule restores the original response.",
    "source": "https://docs.cpanel.net/cpanel/domains/redirects/",
    "upstreamFeatureKey": "redirects",
    "upstreamAcl": "",
    "upstreamApi": "Mime (add_redirect, list_redirects, get_redirect, delete_redirect, redirect_info)",
    "absorbed": [
      {
        "id": "aapanel-site-redirect",
        "name": "Redirect",
        "source": "https://www.aapanel.com/docs/Function/php.html",
        "behaviors": [
          "By domain or by path",
          "Source and target",
          "301 or 302",
          "Keep request path and query option",
          "Several rules, each toggleable"
        ]
      }
    ]
  },
  {
    "id": "zone-editor",
    "behaviors": [
      "Zone list with filter; quick add A, CNAME and MX; open DNSSEC; manage zone; refresh",
      "Records table: name, TTL, type, value, with edit and delete; filter by name or type",
      "Record types: A, AAAA, CAA (flag, tag issue/issuewild/iodef, value), CNAME, MX (priority, target), SRV (priority, weight, port, target), TXT, HTTPS and SVCB (priority, target, params), ALIAS when the DNS backend supports it",
      "DMARC helper that builds the TXT policy record (policy, subdomain policy, alignment modes, percentage, reporting addresses, interval)",
      "Add several records then save all, or cancel",
      "Edits are applied against the current SOA serial so concurrent edits do not clobber each other",
      "Reset zone to server defaults after confirmation (custom records lost)",
      "Record types offered depend on enabled features; temporary domains cannot be edited"
    ],
    "acceptance": "A batch edit submitted with a stale SOA serial is rejected with ZONE_SERIAL_MISMATCH and the zone is unchanged; a successful add of an A record raises the serial and the authoritative server answers the new record to dig within one reconcile cycle.",
    "source": "https://docs.cpanel.net/cpanel/domains/zone-editor/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "edit-dns",
    "upstreamApi": "DNS (parse_zone, mass_edit_zone, is_alias_available, is_https_available, is_svcb_available, has_local_authority, lookup); ZoneEdit::resetzone",
    "absorbed": []
  },
  {
    "id": "dnssec",
    "behaviors": [
      "Key list: tag, type (KSK, ZSK or combined CSK), algorithm, creation date; expand for status and public DNSKEY",
      "Quick create, or custom create with classic (KSK+ZSK) or simple (CSK) layout, algorithm choice and activate-now option",
      "Algorithms offered: RSA/SHA-1, DSA-NSEC3-SHA1, RSASHA1-NSEC3-SHA1, RSA/SHA-256 (default), RSA/SHA-512, ECDSA P-256, ECDSA P-384",
      "NSEC3 settings: iterations, salt, narrow mode, opt-out; or switch to NSEC",
      "Import a KSK or ZSK; export key material with copy button",
      "DS records with digest types for the registrar",
      "Deactivate without deleting; before deleting, remove DS at the registrar and wait at least a day"
    ],
    "acceptance": "Enabling DNSSEC with algorithm 13 creates one CSK, dig +dnssec returns RRSIG for the SOA, and the displayed DS digest matches the DS computed from the published DNSKEY; deactivating the key stops new signatures without deleting the key.",
    "source": "https://docs.cpanel.net/cpanel/domains/zone-editor/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "manage-dns-records",
    "upstreamApi": "DNSSEC (enable_dnssec, disable_dnssec, add_zone_key, import_zone_key, export_zone_key, export_zone_dnskey, activate_zone_key, deactivate_zone_key, remove_zone_key, fetch_ds_records, set_nsec3, unset_nsec3)",
    "absorbed": []
  },
  {
    "id": "dynamic-dns",
    "behaviors": [
      "Create: subdomain label plus parent domain, optional manual IPv4/IPv6, optional description, stay-on-page option",
      "Each entry gets a unique random ID embedded in its update URL",
      "Table: hostname, current IP(s), last change time (only when IP changes), last call time, description",
      "Edit description",
      "Regenerate the update URL (new ID)",
      "Delete permanently (certificate not removed)",
      "View the hostname's TLS certificate for device configuration",
      "Requires the account's zones to be served by the panel's nameservers"
    ],
    "acceptance": "Calling the update URL from 203.0.113.9 sets the host's A record to 203.0.113.9 and bumps last update time; a second call from the same IP changes only last run time; after Recreate URL the old URL returns 404 and the record is unchanged.",
    "source": "https://docs.cpanel.net/cpanel/domains/dynamic-dns/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "DynamicDNS (create, list, set_description, recreate, delete)",
    "absorbed": []
  },
  {
    "id": "site-publisher",
    "behaviors": [
      "Pick a domain (searchable, paginated list with document roots; auto-selected when only one)",
      "Pick a template with preview, name and description; the current template is preselected",
      "Fill template-specific fields",
      "Before writing, archive the current document root; abort if the archive cannot be written (e.g. quota)",
      "Write files, overwriting same-named files; on any write error restore from the archive",
      "Keep backups for 30 days; store the site settings as a JSON file outside the docroot",
      "After publishing, link to email, File Manager and Web Disk",
      "Published files are not removed automatically"
    ],
    "acceptance": "Publishing into a non-empty document root first creates an archive under the account's publisher backup folder; when quota prevents that archive, publishing stops with BACKUP_FAILED and the document root is byte-identical to before.",
    "source": "https://docs.cpanel.net/cpanel/domains/site-publisher/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "sitejet-builder",
    "behaviors": [
      "Listed only for coverage; not implemented"
    ],
    "acceptance": "No Sitejet entry appears in the xPanel catalog or API.",
    "source": "https://docs.cpanel.net/cpanel/domains/sitejet-builder/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Sitejet",
    "absorbed": []
  },
  {
    "id": "wp-toolkit",
    "behaviors": [
      "Listed only for coverage; not implemented"
    ],
    "acceptance": "No WP Toolkit entry appears in the xPanel catalog or API.",
    "source": "https://docs.cpanel.net/cpanel/domains/wp-toolkit-for-cpanel/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "WPX",
    "absorbed": []
  },
  {
    "id": "seo-audit",
    "behaviors": [
      "Listed only for coverage; not implemented"
    ],
    "acceptance": "No SEO audit entry appears in the xPanel catalog.",
    "source": "https://docs.cpanel.net/cpanel/domains/search-engine-optimization/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "SiteQuality",
    "absorbed": []
  },
  {
    "id": "social-media-management",
    "behaviors": [
      "Listed only for coverage; not implemented"
    ],
    "acceptance": "No social media management entry appears in the xPanel catalog.",
    "source": "https://docs.cpanel.net/cpanel/domains/social-media-management/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "domain-purchase",
    "behaviors": [
      "Listed only for coverage; not implemented"
    ],
    "acceptance": "The create-domain flow offers only registered and temporary domain options.",
    "source": "https://docs.cpanel.net/cpanel/domains/domains/create-a-new-domain/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "DomainRecommendations",
    "absorbed": []
  },
  {
    "id": "email-accounts",
    "behaviors": [
      "Header shows the number of mailboxes used against the plan limit, with an infinity marker when unlimited; the built-in system mailbox does not count toward the limit",
      "Table columns: address (local part and domain, each sortable), restriction indicator, storage used / allocated / percent (all sortable)",
      "Row actions: open in webmail, manage, connect devices; overflow menu offers view restrictions and delete",
      "Checkbox multi-select allows bulk delete; the system mailbox cannot be selected or deleted",
      "Delete asks for confirmation and permanently removes mail and settings",
      "Free-text search plus quick filters: restricted only, system mailbox only, over quota only",
      "Page size selector and manual refresh",
      "Mailboxes on a temporary/placeholder domain are not allowed",
      "Whole page can be hidden by the plan's feature list"
    ],
    "acceptance": "With a plan limit of 2 mailboxes and 2 existing, POST create mailbox returns LIMIT_EXCEEDED and the list still shows 2 rows; the system mailbox row has no delete action and a DELETE call on it returns FORBIDDEN.",
    "source": "https://docs.cpanel.net/cpanel/email/email-accounts/",
    "upstreamFeatureKey": "popaccts (Email Accounts)",
    "upstreamAcl": "",
    "upstreamApi": "Email::list_pops_with_disk, Email::count_pops, Email::delete_pop, Email::get_main_account_disk_usage",
    "absorbed": [
      {
        "id": "aapanel-mailboxes",
        "name": "Mailboxes",
        "source": "https://www.aapanel.com/docs/Function/MailServer.html",
        "behaviors": [
          "Add with name, quota, type (regular or admin), address, password and status",
          "Bulk create, import and export",
          "Copy the login details, open webmail, edit, delete"
        ]
      }
    ]
  },
  {
    "id": "email-account-create",
    "behaviors": [
      "Domain selector shown only when the account owns more than one mail domain",
      "Username field; the reserved name 'cpanel' is refused; address cannot be renamed later (users are pointed to forwarders instead)",
      "Password mode: set now (with reveal, generator and generator-complexity options) or email a set-password link to an alternate address (if the host enables it)",
      "Host-defined minimum password strength (0-100 score) is enforced",
      "Storage quota: whole number in MB (UI allows MB..PB units) or Unlimited; Unlimited only when the plan has no per-mailbox cap; cannot exceed the cap",
      "Plus-addressing option: auto-create a folder named after the +tag, or deliver +tag mail to INBOX",
      "Optional welcome message with client setup instructions and an Apple configuration profile; not sent when the link mode is used",
      "'Stay on this page' option to create several in a row",
      "Creates default calendar and address book for the mailbox"
    ],
    "acceptance": "Creating local part 'cpanel' returns VALIDATION_ERROR; creating 'info' with quota 500 when the plan cap is 250 returns QUOTA_EXCEEDS_MAX; creating 'info' with quota 250 and a password scoring below the host minimum returns WEAK_PASSWORD; a valid request yields a mailbox that accepts IMAP login with the given password.",
    "source": "https://docs.cpanel.net/cpanel/email/create-an-email-account/",
    "upstreamFeatureKey": "popaccts (Email Accounts)",
    "upstreamAcl": "",
    "upstreamApi": "Email::add_pop, Email::get_max_email_quota_mib, Email::get_default_email_quota_mib, Email::enable_mailbox_autocreate",
    "absorbed": []
  },
  {
    "id": "email-account-manage",
    "behaviors": [
      "Change password (strength meter, generator); passwords are never retrievable, only replaceable",
      "Optional link to external-authentication (OIDC) linking when the host enables it",
      "Shows current usage and edits allocated quota (whole numbers, max 4096 TB, or Unlimited if no cap); trash is excluded from quota; usage recalculated on login",
      "When the quota is full or set below usage, new mail bounces with a mailbox-full error",
      "Receiving: allow or suspend (reject incoming)",
      "Sending: allow, suspend (reject outgoing) or hold (queue outgoing); switching hold back to allow releases and delivers the queue; held queue can be counted and purged",
      "Login: allow or suspend; suspending also disables aliases/forwarders pointing at it",
      "Plus addressing folder auto-create toggle (tag is case-sensitive)",
      "Shortcut to mailbox cleanup (Email Disk Usage) and to Connect Devices",
      "System mailbox page adds: share system address book toggle and UTF-8 mailbox-name toggle (warning: may break filters)",
      "Delete mailbox with confirmation"
    ],
    "acceptance": "Setting sending=hold then sending a message via authenticated SMTP leaves held count = 1 and nothing delivered; switching to allow delivers the message and held count returns to 0; setting login=suspend makes IMAP login fail while SMTP delivery to the mailbox still succeeds.",
    "source": "https://docs.cpanel.net/cpanel/email/manage-email-accounts/",
    "upstreamFeatureKey": "popaccts (Email Accounts)",
    "upstreamAcl": "",
    "upstreamApi": "Email::passwd_pop, Email::edit_pop_quota, Email::suspend_incoming, Email::unsuspend_incoming, Email::suspend_outgoing, Email::unsuspend_outgoing, Email::hold_outgoing, Email::release_outgoing, Email::get_held_message_count, Email::delete_held_messages, Email::suspend_login, Email::unsuspend_login, Mailboxes::set_utf8_mailbox_names, DAV::enable_shared_global_addressbook",
    "absorbed": []
  },
  {
    "id": "connect-devices",
    "behaviors": [
      "Per-client auto-config downloads (desktop mail apps, Apple iOS/macOS profiles) with IMAP or POP3 and SSL/TLS or plain choices; SSL/TLS recommended",
      "Manual settings: username = full address, password = mailbox password; IMAP recommended over POP3",
      "Secure ports: IMAP 993, POP3 995, SMTP 465; non-SSL ports: IMAP 143, POP3 110, SMTP 587",
      "Secure host = the mail domain when it has a valid certificate, otherwise the server hostname; non-SSL host = mail.<domain>",
      "Send these instructions to any email address",
      "Note that directory (LDAP) auth is not supported for mail apps"
    ],
    "acceptance": "For a domain with a valid certificate the page returns host=<domain>, imap=993, pop3=995, smtp=465; after the certificate is removed the secure host switches to the server hostname; 'send instructions' queues exactly one message to the given address.",
    "source": "https://docs.cpanel.net/cpanel/email/set-up-mail-client/",
    "upstreamFeatureKey": "popaccts (Email Accounts)",
    "upstreamAcl": "",
    "upstreamApi": "Email::get_client_settings, Email::dispatch_client_settings",
    "absorbed": []
  },
  {
    "id": "forwarders",
    "behaviors": [
      "List of address forwarders across all domains, filterable by domain and searchable",
      "Destinations: one or more addresses (comma separated); bounce at SMTP time with custom or default text; deliver to a system user; silent discard (discouraged); pipe to a script",
      "Pipe target is a path relative to the home directory, must be executable with a shebang, mode 0700; any script output generates a bounce",
      "If a mailbox with the same address exists it keeps a copy and the forwarder also receives",
      "Forwarders cannot be edited: delete and recreate",
      "Delete with confirmation",
      "Trace action shows the delivery route for the destination (local, remote, filtered, error)",
      "Wildcard redirects are not forwarders (use filters); catch-all is the Default Address tool"
    ],
    "acceptance": "Creating a forwarder from sales@example.com to a@x.test,b@y.test delivers one copy to each target; creating a forwarder with fwdopt=pipe and a path outside the home directory returns VALIDATION_ERROR; exceeding the plan's forwarder limit returns LIMIT_EXCEEDED.",
    "source": "https://docs.cpanel.net/cpanel/email/forwarders/",
    "upstreamFeatureKey": "Forwarder Manager",
    "upstreamAcl": "",
    "upstreamApi": "Email::add_forwarder, Email::list_forwarders, Email::delete_forwarder, Email::count_forwarders, Email::trace_delivery",
    "absorbed": [
      {
        "id": "aapanel-mail-forward",
        "name": "Mail Forwarding",
        "source": "https://www.aapanel.com/docs/Function/MailServer.html",
        "behaviors": [
          "Address-level or domain-level source",
          "Enable toggle"
        ]
      }
    ]
  },
  {
    "id": "domain-forwarders",
    "behaviors": [
      "Table of domain-level forwarders on the account",
      "Add: choose source domain, type destination domain",
      "Applies only when no mailbox, forwarder or autoresponder matches the address",
      "Takes priority over the domain's default (catch-all) address",
      "Delete with confirmation"
    ],
    "acceptance": "With example.com forwarded to example.net, mail to nobody@example.com is delivered to nobody@example.net while mail to an existing mailbox info@example.com is still delivered locally; adding a second forwarder for the same source domain returns CONFLICT.",
    "source": "https://docs.cpanel.net/cpanel/email/forwarders/",
    "upstreamFeatureKey": "emaildomainfwd (Email Domain Forwarding)",
    "upstreamAcl": "",
    "upstreamApi": "Email::add_domain_forwarder, Email::list_domain_forwarders, Email::delete_domain_forwarder",
    "absorbed": []
  },
  {
    "id": "email-routing",
    "behaviors": [
      "Per-domain choice: automatic (recommended), local, backup, remote",
      "Automatic uses only the local zone file: lowest-priority MX on a server IP = local; on a non-server IP while another MX points here = backup; no MX here = remote; no live DNS lookup",
      "Automatic choice is not re-evaluated when MX records change later",
      "Local: always accept and deliver locally (for smart-host/gateway setups or missing zones)",
      "Backup: queue and hold until a higher-priority MX is reachable",
      "Remote: do not accept; relay to lowest MX",
      "Shows current MX records with a pointer to the DNS editor; warns that a wrong choice can stop mail"
    ],
    "acceptance": "Setting routing=remote for example.com makes the MTA stop local delivery for example.com (local RCPT is relayed or refused) and the stored mode reads 'remote'; mode=auto on a zone whose lowest MX resolves to a server IP stores effective mode 'local'.",
    "source": "https://docs.cpanel.net/cpanel/email/email-routing/",
    "upstreamFeatureKey": "changemx (Email Routing)",
    "upstreamAcl": "",
    "upstreamApi": "Email::set_always_accept, Email::list_mxs, Email::add_mx, Email::change_mx, Email::delete_mx",
    "absorbed": []
  },
  {
    "id": "autoresponders",
    "behaviors": [
      "Fields: charset (default UTF-8), interval in hours between replies to the same sender (0 = reply to every message), address, sender name, subject, HTML toggle, body, start (now or custom), stop (never or custom)",
      "Body placeholders for incoming subject, sender name and sender address",
      "Stop time must be after start time; times converted to GMT",
      "Only one autoresponder per address",
      "Original mail still delivered to the inbox",
      "Messages with spam score 5 or higher get no auto-reply",
      "List per domain with search; edit and delete with confirmation"
    ],
    "acceptance": "With interval=24, two messages from the same sender within an hour produce exactly one reply and both originals land in INBOX; creating a second autoresponder for the same address returns CONFLICT; stop earlier than start returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/cpanel/email/autoresponders/",
    "upstreamFeatureKey": "Autoresponders",
    "upstreamAcl": "",
    "upstreamApi": "Email::add_auto_responder, Email::get_auto_responder, Email::list_auto_responders, Email::delete_auto_responder, Email::count_auto_responders, Email::get_charsets",
    "absorbed": [
      {
        "id": "aapanel-mail-autoresponder",
        "name": "Mail Auto Responder",
        "source": "https://www.aapanel.com/docs/Function/MailServer.html",
        "behaviors": [
          "Reply content",
          "Enable toggle"
        ]
      }
    ]
  },
  {
    "id": "default-address",
    "behaviors": [
      "Domain selector",
      "Options: bounce at SMTP time with a sender-visible message; forward to an address or the account username; deliver to the system mailbox; pipe to a program; silent discard (discouraged)",
      "Advanced options reveal system/pipe/discard",
      "Warns that catch-alls attract spam",
      "Domain forwarders override the default address"
    ],
    "acceptance": "With mode=fail and custom text 'gone', RCPT TO:<missing@example.com> is rejected with a 5xx containing 'gone'; with mode=fwd to admin@example.com the same message is delivered to admin@example.com.",
    "source": "https://docs.cpanel.net/cpanel/email/default-address/",
    "upstreamFeatureKey": "defaultaddress (Default Address)",
    "upstreamAcl": "",
    "upstreamApi": "Email::set_default_address, Email::list_default_address",
    "absorbed": []
  },
  {
    "id": "mailing-lists",
    "behaviors": [
      "Create: list name (letters, digits, underscore, dot, dash; no spaces), domain, password with strength meter/generator, access type public (open subscribe, listed) or private (admin approval, hidden)",
      "Table: full list address, disk usage, access, administrators, actions; search",
      "Manage opens the list admin UI with single sign-on (subscribers, moderation, options)",
      "Change list password without the old one",
      "Delegate admin rights to existing mailboxes (warned as high-privilege)",
      "Delete with confirmation",
      "Service only starts once at least one list exists; host must enable it"
    ],
    "acceptance": "Creating list 'my list' returns VALIDATION_ERROR; a private list does not appear in the public list index; exceeding the plan's list limit returns LIMIT_EXCEEDED; a delegated mailbox can approve a held post.",
    "source": "https://docs.cpanel.net/cpanel/email/mailing-lists/",
    "upstreamFeatureKey": "Mailing Lists",
    "upstreamAcl": "",
    "upstreamApi": "Email::add_list, Email::list_lists, Email::delete_list, Email::passwd_list, Email::set_list_privacy_options, Email::add_mailman_delegates, Email::remove_mailman_delegates, Email::get_mailman_delegates, Email::get_lists_total_disk_usage",
    "absorbed": []
  },
  {
    "id": "track-delivery",
    "behaviors": [
      "Optional recipient filter; run report",
      "Quick views: blocked & failed only, or all",
      "Record type checkboxes: successes, deferred, failures, in progress; max results per type",
      "Default columns: status icon, from address, sender user, sent time (browser timezone), spam score, recipient, result text, details",
      "Optional columns: user, domain, delivery user/domain, sender host/IP, authentication, delivered-to, router, transport, out time, message ID, delivery host/IP, size",
      "Status types: success, in progress, deferred, error, archived, rejected at SMTP, filtered",
      "Route trace diagram for an address (local, remote, deferred, rejected, discarded)",
      "Defaults to the 250 newest records; retention days set by the server admin (1-365000)",
      "Printable detail view"
    ],
    "acceptance": "After sending one message to an unresolvable domain, the report lists it with status=error within 60 s; filtering 'Show failures' only returns no success rows; an unfiltered query returns at most 250 rows.",
    "source": "https://docs.cpanel.net/cpanel/email/track-delivery/",
    "upstreamFeatureKey": "Email Trace",
    "upstreamAcl": "",
    "upstreamApi": "EmailTrack::search (API 2), EmailTrack::trace (API 2), Email::trace_delivery",
    "absorbed": []
  },
  {
    "id": "global-email-filters",
    "behaviors": [
      "Create named filter with one or more rules and one or more actions",
      "Rule fields: From, Subject, To, reply address, body, any header, any recipient, not previously delivered, is a bounce, list ID, spam status, spam bar, spam score",
      "String operators: equals, matches regex (PCRE), contains, not contains, begins, not begins, ends, not ends, not matches; numeric (spam score): above, not above, below, not below",
      "Rules combined with and/or; 'and' binds tighter than 'or'",
      "Actions: discard, redirect to address (no local copy), fail with message, stop processing, deliver to folder, pipe to program (if host allows)",
      "BCC cannot be matched; body newlines become spaces",
      "Wildcard redirect = From matches regex with .+ in place of wildcards",
      "Edit, delete with confirmation, list current filters",
      "Test box: paste a sample message and see per-condition true/false trace and final disposition",
      "Guidance: many small filters perform better than one large one"
    ],
    "acceptance": "An account-level filter 'Subject contains PROMO -> deliver to folder Promo' moves a matching test message for any mailbox on the account into Promo; the test endpoint with a matching sample reports the condition true and does not deliver anything.",
    "source": "https://docs.cpanel.net/cpanel/email/global-email-filters/",
    "upstreamFeatureKey": "Email Filtering Manager",
    "upstreamAcl": "",
    "upstreamApi": "Email::store_filter, Email::list_filters, Email::get_filter, Email::delete_filter, Email::enable_filter, Email::disable_filter, Email::trace_filter, Email::reorder_filters",
    "absorbed": []
  },
  {
    "id": "email-filters",
    "behaviors": [
      "Pick a mailbox from the filters-by-user table (webmail users go straight to their own)",
      "Same rule fields, operators and actions as global filters",
      "Filters run in list order; new ones appended at the end; drag-and-drop reordering",
      "Edit, delete with confirmation",
      "Filter test with trace output"
    ],
    "acceptance": "For mailbox a@example.com with filter 1 'From equals x@y.test -> stop processing' above filter 2 'From equals x@y.test -> discard', a message from x@y.test is delivered; after reordering filter 2 first, the same message is discarded; mailbox b@example.com is unaffected.",
    "source": "https://docs.cpanel.net/cpanel/email/email-filters/",
    "upstreamFeatureKey": "Email Filtering Manager",
    "upstreamAcl": "",
    "upstreamApi": "Email::store_filter (account param), Email::list_filters, Email::reorder_filters, Email::delete_filter, Email::trace_filter, Email::count_filters",
    "absorbed": []
  },
  {
    "id": "email-deliverability",
    "behaviors": [
      "Lists every domain with a zone on the server, main domain marked, with an overall status; sortable, paged",
      "Repair per domain: shows suggested records (copy/customize) and installs them; recheck can take minutes; unavailable when the server is not authoritative for the zone; domains in the same zone repaired one at a time",
      "Manage per domain: DKIM (generate local key if absent, copy name/value, full or 255-char split view, view private key with warning)",
      "SPF: copy/view; custom builder adding hosts (a), MX, IP/CIDR blocks, include domains, and hard-fail (-all) vs default soft-fail (~all); preview then install",
      "DMARC: suggested record; installable only when authoritative; needs valid SPF and DKIM",
      "PTR: verifies reverse DNS of the sending IP with fix instructions; hidden when a smart host is used",
      "HELO mismatch notice",
      "Domains whose zones remain on the server keep appearing until the admin removes the zone"
    ],
    "acceptance": "A locally authoritative zone with no SPF/DKIM reports status=problem; after repair the zone contains one v=spf1 TXT and a DKIM TXT at default._domainkey and status becomes valid; repair on a non-authoritative zone returns NOT_AUTHORITATIVE.",
    "source": "https://docs.cpanel.net/cpanel/email/email-deliverability-in-cpanel/",
    "upstreamFeatureKey": "emailauth (Email Deliverability)",
    "upstreamAcl": "",
    "upstreamApi": "EmailAuth::validate_current_dkims, EmailAuth::validate_current_spfs, EmailAuth::validate_current_ptrs, EmailAuth::validate_current_dmarcs, EmailAuth::ensure_dkim_keys_exist, EmailAuth::install_dkim_private_keys, EmailAuth::install_spf_records, EmailAuth::apply_dmarc, EmailAuth::enable_dkim, EmailAuth::disable_dkim",
    "absorbed": []
  },
  {
    "id": "address-importer",
    "behaviors": [
      "Choose import type: mailboxes or forwarders",
      "Upload .csv, .xls or one-entry-per-line text",
      "CSV delimiter choice (comma, other custom character); first row as header option",
      "Map each column to email, password, domain or ignore",
      "Apply one domain to entries without a domain part",
      "Mailbox imports need a password per row with strength score 65+; default quota in MB",
      "Review then finish; offer to import more"
    ],
    "acceptance": "Importing a 3-row CSV where one row has a weak password creates exactly 2 mailboxes and reports the third as WEAK_PASSWORD; an import that would exceed the plan mailbox limit stops at the limit and reports LIMIT_EXCEEDED for the remainder.",
    "source": "https://docs.cpanel.net/cpanel/email/address-importer/",
    "upstreamFeatureKey": "Address Importer",
    "upstreamAcl": "",
    "upstreamApi": "CSVImport::doimport (type email|fwd), CSVImport::uploadimport (API 2)",
    "absorbed": []
  },
  {
    "id": "spam-filters",
    "behaviors": [
      "Toggle scoring of incoming mail (cannot be turned off if the host forces it); spam box and auto-delete depend on it",
      "Spam threshold score: presets or custom; default 5; must be greater than 0",
      "Spam box: move spam to a 'spam' folder (counts toward quota); empty for one mailbox or all mailboxes; POP3 access via a /spam username suffix",
      "Auto-delete: permanently delete mail at or above a separate threshold",
      "Allow list and deny list of senders with * and ? wildcards and entry counts",
      "Per-test score overrides (up to 3 decimals; 0 disables a test)"
    ],
    "acceptance": "With threshold 5 and spam box on, a GTUBE test message lands in the 'spam' folder; the same message from a sender on the allow list lands in INBOX; setting threshold 0 returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/cpanel/email/spam-filters/",
    "upstreamFeatureKey": "spamassassin, spambox (Apache SpamAssassin, Spam Box)",
    "upstreamAcl": "",
    "upstreamApi": "Email::enable_spam_assassin, Email::disable_spam_assassin, Email::add_spam_filter, Email::enable_spam_box, Email::disable_spam_box, Email::disable_spam_autodelete, Email::get_spam_settings, SpamAssassin::get_user_preferences, SpamAssassin::update_user_preference, SpamAssassin::clear_spam_box, SpamAssassin::get_symbolic_test_names",
    "absorbed": []
  },
  {
    "id": "email-encryption",
    "behaviors": [
      "Generate: name, email, optional comment, passphrase, expiry (default one year or no expiry), key size 1024/2048/3072/4096 (default 2048)",
      "Import a pasted armored key",
      "Separate tables for public and private keys",
      "View armored key block; export public or secret key",
      "Delete with confirmation; the private key must be removed before its public key",
      "Generation can be slow on low-entropy systems"
    ],
    "acceptance": "Generating with keysize 3072 lists the key in both tables with matching fingerprint; keysize 512 returns VALIDATION_ERROR; deleting the public key while its private key exists returns CONFLICT.",
    "source": "https://docs.cpanel.net/cpanel/email/encryption/",
    "upstreamFeatureKey": "Encryption (PGP/GPG)",
    "upstreamAcl": "",
    "upstreamApi": "GPG::generate_key, GPG::import_key, GPG::list_public_keys, GPG::list_secret_keys, GPG::export_public_key, GPG::export_secret_key, GPG::delete_keypair",
    "absorbed": []
  },
  {
    "id": "sender-verification",
    "behaviors": [
      "Enable/disable per mailbox; enabling auto-allows addresses the user writes to",
      "Settings: extra addresses delivering into this mailbox, display name, days to keep log and queue, spam score below which mail bypasses verification (default -2.5), auto-allow recipients of outgoing mail, allow by association (To/CC of allowed mail)",
      "Lists: allow (deliver), ignore (silently drop, beats allow), deny (drop and notify)",
      "Forward list for allowed mail",
      "Editable templates: verify request, released notice, verification failed, deny notice, with placeholders and reset to default; the verify subject token must remain intact",
      "Daily activity log",
      "Queue by day: deliver and allow, delete, ignore or deny sender; view full message and headers"
    ],
    "acceptance": "With verification on, a message from an unknown sender is queued (not in INBOX) and one verification email is sent; when the sender replies with the correct token the message moves to INBOX and the sender appears in the allow list; a sender on the ignore list and the allow list is dropped silently.",
    "source": "https://docs.cpanel.net/cpanel/email/boxtrapper/",
    "upstreamFeatureKey": "boxtrapper (BoxTrapper)",
    "upstreamAcl": "",
    "upstreamApi": "BoxTrapper::set_status, BoxTrapper::get_status, BoxTrapper::get_configuration, BoxTrapper::save_configuration, BoxTrapper::get_allowlist, BoxTrapper::set_allowlist, BoxTrapper::get_blocklist, BoxTrapper::set_blocklist, BoxTrapper::get_ignorelist, BoxTrapper::set_ignorelist, BoxTrapper::list_queued_messages, BoxTrapper::deliver_messages, BoxTrapper::whitelist_messages, BoxTrapper::delete_messages, BoxTrapper::blacklist_messages, BoxTrapper::ignore_messages, BoxTrapper::get_log, BoxTrapper::list_email_templates, BoxTrapper::save_email_template, BoxTrapper::reset_email_template, BoxTrapper::get_forwarders, BoxTrapper::set_forwarders",
    "absorbed": []
  },
  {
    "id": "greylisting",
    "behaviors": [
      "Domain list with on/off toggle and search",
      "Bulk enable all / disable all",
      "Tracks triplets of sending IP, sender address and recipient; unknown triplets are deferred (default 5 minutes, admin-tunable) then accepted on retry",
      "Visible only if the host enables the feature and the greylisting service",
      "Deferred attempts visible in Track Delivery"
    ],
    "acceptance": "With greylisting on for example.com, the first SMTP attempt from a new IP/sender/recipient triplet receives a 4xx deferral and a retry after the deferral window is accepted; with greylisting off the first attempt is accepted.",
    "source": "https://docs.cpanel.net/cpanel/email/configure-greylisting/",
    "upstreamFeatureKey": "Configure Greylisting",
    "upstreamAcl": "",
    "upstreamApi": "cPGreyList::list_domains, cPGreyList::enable_domains, cPGreyList::disable_domains, cPGreyList::enable_all_domains, cPGreyList::disable_all_domains, cPGreyList::has_greylisting_enabled",
    "absorbed": []
  },
  {
    "id": "email-archive",
    "behaviors": [
      "Per domain: enable incoming / outgoing / mailing-list archiving with a retention period each",
      "Default type and retention that can be applied to all domains",
      "Archives taken before filtering, including spam; mail from before enabling is not archived",
      "Stored under the mail directory in daily folders named type.YYYY-MM-DD (GMT, not changeable)",
      "Read-only IMAP access (993 SSL / 143 plain) with archive address as username",
      "Download .zip of all or one archive type; open in webmail",
      "Warns about disk usage growth"
    ],
    "acceptance": "With incoming archiving enabled at 30 days for example.com, a received message appears in the incoming archive folder for today's GMT date; a nightly purge removes folders older than 30 days; IMAP APPEND to the archive mailbox is rejected (read-only).",
    "source": "https://docs.cpanel.net/cpanel/email/archive/",
    "upstreamFeatureKey": "emailarchive (Email Archiving)",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "calendars-contacts-config",
    "behaviors": [
      "Per mailbox: username (full address), password note (same as mail), HTTPS server URL on the DAV port, alternate principal URL for clients without autodiscovery",
      "Direct calendar and address book collection URLs",
      "Client notes for iOS, macOS, Thunderbird, Android/Outlook via third-party sync apps",
      "Self-signed certificates break some clients"
    ],
    "acceptance": "For info@example.com the page returns an https URL with the DAV port and a /principals/ path containing the address; a PROPFIND on that principal URL with the mailbox credentials returns 207 and with a wrong password returns 401.",
    "source": "https://docs.cpanel.net/knowledge-base/webmail/how-to-set-up-calendars-and-contacts/",
    "upstreamFeatureKey": "Calendars and Contacts",
    "upstreamAcl": "",
    "upstreamApi": "DAV::get_calendar_contacts_config, DAV::is_dav_service_enabled",
    "absorbed": []
  },
  {
    "id": "calendars-contacts-management",
    "behaviors": [
      "Table: name, type, description, actions",
      "Create: type calendar / address book / task list, name, optional description, color for calendars",
      "Edit name, color, description",
      "Delete with confirmation",
      "Default calendar and address book are created with each mailbox and cannot be deleted"
    ],
    "acceptance": "Creating calendar 'Team' with a color makes it discoverable via CalDAV for that mailbox; deleting the default calendar returns PROTECTED_RESOURCE.",
    "source": "https://docs.cpanel.net/cpanel/email/calendars-and-contacts-management/",
    "upstreamFeatureKey": "Calendars and Contacts",
    "upstreamAcl": "",
    "upstreamApi": "CPDAVD::manage_collection",
    "absorbed": []
  },
  {
    "id": "calendars-contacts-sharing",
    "behaviors": [
      "Pick owner mailbox, collection and recipient mailbox; read-only by default, optional allow editing",
      "Requires at least two mailboxes; recipients limited to the same hosting account",
      "Shared collections table: owner, name, path, recipient, permission",
      "Toggle editing later; revoke with confirmation",
      "Invites in shared calendars only for events you created"
    ],
    "acceptance": "After a read-only share, the recipient can GET events but PUT returns 403; after allow-editing, PUT succeeds; sharing to a mailbox of a different hosting account returns FORBIDDEN.",
    "source": "https://docs.cpanel.net/cpanel/email/calendars-and-contacts-sharing/",
    "upstreamFeatureKey": "Calendars and Contacts",
    "upstreamAcl": "",
    "upstreamApi": "CPDAVD::add_delegate, CPDAVD::list_delegates, CPDAVD::update_delegate, CPDAVD::remove_delegate, CPDAVD::list_users",
    "absorbed": []
  },
  {
    "id": "email-disk-usage",
    "behaviors": [
      "Mailbox selector (account owner only)",
      "Folder table: name, message count, size; sortable; search by folder",
      "Cleanup presets: one year or older, 30 MB or larger, already read, all messages, custom search query (IMAP-search style such as LARGER/BEFORE)",
      "Permanent deletion confirmation",
      "Values may lag due to caching"
    ],
    "acceptance": "Running the '30 MB or larger' preset on INBOX holding one 35 MB and one 1 MB message deletes only the 35 MB message and the folder size drops accordingly; an empty custom query returns VALIDATION_ERROR (prevents delete-all by accident).",
    "source": "https://docs.cpanel.net/cpanel/email/email-disk-usage/",
    "upstreamFeatureKey": "email_disk_usage (Email Disk Usage)",
    "upstreamAcl": "",
    "upstreamApi": "Mailboxes::get_mailbox_status_list, Mailboxes::expunge_mailbox_messages, Mailboxes::expunge_messages_for_mailbox_guid",
    "absorbed": []
  },
  {
    "id": "visitors",
    "behaviors": [
      "Domain list; open a domain's recent hits",
      "Default columns: client IP, requested URL, time, response bytes, referrer, user agent",
      "Optional columns: HTTP status, method, protocol version",
      "Search box over entries",
      "Fewer entries after log rotation; SSL and non-SSL logs read from the domain's access logs"
    ],
    "acceptance": "After three HTTP requests to example.com with a custom user agent, the visitors view lists three entries with that user agent and correct status when the status column is enabled; entries from another account's domain never appear.",
    "source": "https://docs.cpanel.net/cpanel/metrics/visitors/",
    "upstreamFeatureKey": "Latest Visitors",
    "upstreamAcl": "",
    "upstreamApi": "Stats::lastvisitors, Stats::listlastvisitors (API 2)",
    "absorbed": [
      {
        "id": "aapanel-site-logs",
        "name": "Site Logs and Log Analysis",
        "source": "https://www.aapanel.com/docs/Function/php.html",
        "behaviors": [
          "Access and error log viewer with search",
          "Scan for XSS, SQL injection, scanner and PHP attack patterns, grouped by IP and URL"
        ]
      }
    ]
  },
  {
    "id": "errors",
    "behaviors": [
      "Up to 300 newest entries, newest first",
      "Includes the web server error log and execution-wrapper log lines that mention the account user",
      "Older lines require opening log files directly",
      "Behind a reverse proxy only backend web-server errors appear"
    ],
    "acceptance": "After triggering 310 PHP errors on example.com the view returns exactly 300 lines ordered newest first; no line belongs to another account's vhost.",
    "source": "https://docs.cpanel.net/cpanel/metrics/errors/",
    "upstreamFeatureKey": "Error Log",
    "upstreamAcl": "",
    "upstreamApi": "Stats::get_site_errors, LogManager::list_error_logs, LogManager::view_error_log",
    "absorbed": []
  },
  {
    "id": "bandwidth",
    "behaviors": [
      "Categories: HTTP, IMAP, POP3, SMTP (sent only), FTP, total",
      "Shows server timezone with notice when the browser differs",
      "Past 24 h and past week rate graphs (5-minute averages), past year totals",
      "Monthly pie charts per service and domain; click for monthly detail",
      "Monthly detail: hourly averages, per-service graphs, daily 30-minute graph, per-day table in MB",
      "Not counted: file-manager transfers, inbound mail, IMAP/POP polling, DNS, cron network traffic",
      "Retention per sampling interval (5min, hourly, daily)"
    ],
    "acceptance": "Downloading a 10 MB file over HTTP from example.com increases that day's HTTP bytes for example.com by between 10 and 11 MB in the daily query; receiving a 5 MB inbound message does not change SMTP totals.",
    "source": "https://docs.cpanel.net/cpanel/metrics/bandwidth/",
    "upstreamFeatureKey": "bandwidth (Bandwidth Stats)",
    "upstreamAcl": "",
    "upstreamApi": "Bandwidth::query, Bandwidth::get_enabled_protocols, Bandwidth::get_retention_periods, Stats::get_bandwidth",
    "absorbed": []
  },
  {
    "id": "raw-access",
    "behaviors": [
      "Settings: archive logs into ~/logs after each stats run (daily by default), remove last month's archives at month end, custom retention days (0 = forever, -1 = server default)",
      "Current logs table per domain with last update, size and attached parked domains; gzip download",
      "Archived logs list with name, created date, download and delete",
      "Empty state when no archives"
    ],
    "acceptance": "Downloading example.com's current log returns a valid gzip whose lines match the access log; with retention_days=7 an archive dated 8 days ago is removed on the next stats run; retention_days=-2 returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/cpanel/metrics/raw-access/",
    "upstreamFeatureKey": "Raw Access Logs",
    "upstreamAcl": "",
    "upstreamApi": "LogManager::get_settings, LogManager::set_settings, LogManager::list_archives, LogManager::delete_archive, Stats::listrawlogs (API 2)",
    "absorbed": []
  },
  {
    "id": "web-stats-awstats",
    "behaviors": [
      "Domain list with view action, separate SSL and non-SSL reports",
      "Monthly history, days of month, hours",
      "Visitor origins, entry links/referrers, HTTP status codes, operating systems, browsers",
      "Admin may allow a per-user config include"
    ],
    "acceptance": "After the stats job processes a log with 100 hits from 10 IPs on one day, the report for that day shows 100 hits and 10 unique visitors; disabling the analyzer for the domain in Metrics Editor stops new report updates.",
    "source": "https://docs.cpanel.net/cpanel/metrics/awstats/",
    "upstreamFeatureKey": "Awstats",
    "upstreamAcl": "",
    "upstreamApi": "Stats::get_stats_daily, Stats::list_stats_by_domain, Stats::listawstats (API 2)",
    "absorbed": []
  },
  {
    "id": "web-stats-analog",
    "behaviors": [
      "Domain list with view action",
      "Month list; each month opens graphs and category tables"
    ],
    "acceptance": "After processing a month of logs, the domain's month list contains that month and its total request count equals the processed log line count.",
    "source": "https://docs.cpanel.net/cpanel/metrics/analog-stats/",
    "upstreamFeatureKey": "Analog Stats",
    "upstreamAcl": "",
    "upstreamApi": "Stats::listanalog (API 2)",
    "absorbed": []
  },
  {
    "id": "web-stats-webalizer",
    "behaviors": [
      "Domain list with non-SSL and SSL entries",
      "Monthly summary links",
      "Month detail: daily and hourly stats, entry links, status codes, operating systems, browsers, countries"
    ],
    "acceptance": "A domain serving both HTTP and HTTPS shows two separate report entries, and HTTPS hits are counted only in the SSL entry.",
    "source": "https://docs.cpanel.net/cpanel/metrics/webalizer/",
    "upstreamFeatureKey": "Webalizer",
    "upstreamAcl": "",
    "upstreamApi": "Stats::listwebalizer (API 2)",
    "absorbed": []
  },
  {
    "id": "web-stats-ftp",
    "behaviors": [
      "Entry per domain with summary graph",
      "Monthly detail: daily and hourly transfers and visitor breakdowns",
      "Visible only when the Webalizer feature is enabled"
    ],
    "acceptance": "After two FTP downloads by the account's FTP user, the current month's FTP report shows two transfers with the correct byte total.",
    "source": "https://docs.cpanel.net/cpanel/metrics/webalizer-ftp/",
    "upstreamFeatureKey": "Webalizer",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "metrics-editor",
    "behaviors": [
      "Per-domain checkboxes for each analyzer (AWStats, Analog, Webalizer equivalents)",
      "Save applies to the next stats run",
      "Lock indicator when the admin or reseller controls the choice"
    ],
    "acceptance": "Unchecking Webalizer for example.com means the next stats run produces no new Webalizer output for it; when the admin locks analyzer choice, save returns FORBIDDEN and nothing changes.",
    "source": "https://docs.cpanel.net/cpanel/metrics/metrics-editor/",
    "upstreamFeatureKey": "Metrics Editor",
    "upstreamAcl": "",
    "upstreamApi": "StatsManager::get_configuration, StatsManager::save_configuration",
    "absorbed": []
  },
  {
    "id": "account-usage-stats",
    "behaviors": [
      "Items: disk usage, optional file count, cached MySQL and PostgreSQL disk, monthly bandwidth, addon domains, subdomains, aliases, mailboxes, mailing lists, autoresponders, forwarders, email filters, FTP accounts, MySQL and PostgreSQL databases",
      "Each item: display name, usage, maximum (null = unlimited), formatter (bytes, bytes/s, percent), link to the managing tool",
      "Near-limit and at-limit messages",
      "Items hidden when the related service or server role is disabled"
    ],
    "acceptance": "Creating one mailbox raises email_accounts usage by exactly 1; a plan with unlimited mailboxes returns maximum=null; when bandwidth reaches the plan maximum the item reports is_maxed=1.",
    "source": "https://api.docs.cpanel.net/specifications/cpanel.openapi/resource-usage-and-statistics",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "ResourceUsage::get_usages, StatsBar::get_stats, Quota::get_quota_info",
    "absorbed": []
  },
  {
    "id": "resource-usage",
    "behaviors": [
      "Vendor plugin page present only on CloudLinux servers"
    ],
    "acceptance": "Not built; the Metrics group renders without this tile and no route exists for it.",
    "source": "https://docs.cpanel.net/whm/packages/feature-manager/",
    "upstreamFeatureKey": "resource-usage",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "cpu-concurrent-connections",
    "behaviors": [
      "Exists only on CloudLinux servers; defers to the vendor's LVE Manager plugin"
    ],
    "acceptance": "Not built; no route or tile.",
    "source": "https://docs.cpanel.net/cpanel/metrics/cpu-and-concurrent-connection-usage/",
    "upstreamFeatureKey": "CPU and Concurrent Connection Usage (deprecated)",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "site-quality-monitoring",
    "behaviors": [
      "Free and paid tiers, vendor sign-up, payment window",
      "Category checks, crawls for dead links and oversize files, 0-100 scores, email alerts"
    ],
    "acceptance": "Not built; no route or tile.",
    "source": "https://docs.cpanel.net/cpanel/metrics/site-quality-monitoring/",
    "upstreamFeatureKey": "Site Quality Monitoring",
    "upstreamAcl": "",
    "upstreamApi": "SiteQuality::*",
    "absorbed": []
  },
  {
    "id": "ssh-access",
    "behaviors": [
      "Generate: optional name (default id_rsa), passphrase with strength meter (may be required by host), key type RSA or DSA, key size (1024+); key unusable until authorized",
      "Import: name (default id_dsa), paste private and/or public key",
      "Public keys table: name, authorized state; authorize/deauthorize, view/download, delete",
      "Private keys table: view/download, delete; PuTTY .ppk conversion",
      "Reserved filenames refused: config, known_hosts, authorized_keys, environment, rc, identity, user",
      "Only available if the host grants shell access"
    ],
    "acceptance": "Generating a key named 'authorized_keys' returns VALIDATION_ERROR; authorizing a generated public key appends exactly one line to ~/.ssh/authorized_keys and an SSH login with the private key succeeds; deauthorizing removes that line and login fails.",
    "source": "https://docs.cpanel.net/cpanel/security/ssh-access/",
    "upstreamFeatureKey": "SSH Access & Terminal",
    "upstreamAcl": "",
    "upstreamApi": "SSH::genkey, SSH::importkey, SSH::listkeys, SSH::authkey, SSH::fetchkey, SSH::delkey, SSH::converttoppk (all API 2); SSH::get_port, SSH::get_shell",
    "absorbed": []
  },
  {
    "id": "ip-blocker",
    "behaviors": [
      "Input accepts single IP, full range a-b, implied range a.b.c.d-e, CIDR, prefix like '10.' for a whole block, or a hostname",
      "Ranges are normalized into CIDR blocks",
      "Table: stored CIDR, first IP, last IP, delete action with confirmation",
      "Blocks only the websites (not webmail/other services); server-wide blocking is an admin tool",
      "Rules written to the account's .htaccess; hand edits must use CIDR"
    ],
    "acceptance": "Adding 10.5.3.3-40 stores CIDR blocks covering exactly 10.5.3.3 through 10.5.3.40; a request from 10.5.3.10 to the site returns 403 while a request from 10.5.3.41 returns 200; input 'abc' returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/cpanel/security/ip-blocker/",
    "upstreamFeatureKey": "IP Blocker",
    "upstreamAcl": "",
    "upstreamApi": "BlockIP::add_ip, BlockIP::remove_ip, DenyIp::listdenyips (API 2)",
    "absorbed": []
  },
  {
    "id": "ssl-private-keys",
    "behaviors": [
      "Generate with key type: system default, RSA 2048, RSA 4096, ECDSA P-256, ECDSA P-384; optional description",
      "Upload by paste or .key file",
      "Table: description, ID, key type, actions",
      "Edit description; view encoded and decoded key",
      "Delete with confirmation"
    ],
    "acceptance": "Generating keytype ecdsa-secp384r1 stores a key whose parsed curve is P-384; uploading text that is not a PEM private key returns INVALID_PEM.",
    "source": "https://docs.cpanel.net/cpanel/security/ssl-tls/",
    "upstreamFeatureKey": "SSL/TLS",
    "upstreamAcl": "",
    "upstreamApi": "SSL::generate_key, SSL::upload_key, SSL::list_keys, SSL::show_key, SSL::set_key_friendly_name, SSL::delete_key",
    "absorbed": []
  },
  {
    "id": "ssl-csrs",
    "behaviors": [
      "Select existing key, enter domains and subject details (city, state, country, company, etc.); host may require more",
      "Table: domains, created (UTC), description, actions",
      "View encoded/decoded, edit description, delete with confirmation"
    ],
    "acceptance": "A CSR generated from key K for example.com and www.example.com has both names as SANs and its public key equals K's public key; a CSR without any domain returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/cpanel/security/ssl-tls/",
    "upstreamFeatureKey": "SSL/TLS",
    "upstreamAcl": "",
    "upstreamApi": "SSL::generate_csr, SSL::list_csrs, SSL::show_csr, SSL::set_csr_friendly_name, SSL::delete_csr, SSL::find_csrs_for_key",
    "absorbed": []
  },
  {
    "id": "ssl-certificates",
    "behaviors": [
      "Table: domains, issuer, expiry (UTC), key type, description; edit, delete, install actions",
      "Upload by paste or .crt file with optional description",
      "Self-signed generation: pick key; domains, city, state, country, company required; meant for internal use",
      "View encoded/decoded, edit description, delete with confirmation"
    ],
    "acceptance": "Generating a self-signed certificate without the country field returns VALIDATION_ERROR; with all required fields the stored certificate lists the given domains and is self-issued.",
    "source": "https://docs.cpanel.net/cpanel/security/ssl-tls/",
    "upstreamFeatureKey": "SSL/TLS",
    "upstreamAcl": "",
    "upstreamApi": "SSL::upload_cert, SSL::generate_cert, SSL::list_certs, SSL::show_cert, SSL::set_cert_friendly_name, SSL::delete_cert, SSL::fetch_cert_info",
    "absorbed": []
  },
  {
    "id": "ssl-install",
    "behaviors": [
      "Installed sites table: FQDN, expiry, document root; make primary (shared IP), uninstall with confirmation, update certificate, details, reuse for a new site",
      "Install form: browse stored certificates, autofill by domain (cert, key, bundle), or paste certificate, key and optional CA bundle",
      "Key must match the certificate; bundle fetched when possible",
      "Mail SNI per domain; webmail keeps the service certificate",
      "HTTPS redirect toggle per domain"
    ],
    "acceptance": "Installing a certificate with a non-matching key returns KEY_MISMATCH and changes nothing; after a valid install, a TLS handshake to example.com:443 presents that certificate's serial; uninstall restores the previous (or default) certificate.",
    "source": "https://docs.cpanel.net/cpanel/security/ssl-tls/",
    "upstreamFeatureKey": "sslinstall (SSL Host Installer)",
    "upstreamAcl": "",
    "upstreamApi": "SSL::install_ssl, SSL::installed_hosts, SSL::installed_host, SSL::delete_ssl, SSL::set_primary_ssl, SSL::fetch_best_for_domain, SSL::fetch_key_and_cabundle_for_certificate, SSL::get_cabundle, SSL::enable_mail_sni, SSL::disable_mail_sni, SSL::toggle_ssl_redirect_for_domains",
    "absorbed": [
      {
        "id": "aapanel-site-ssl",
        "name": "Site SSL",
        "source": "https://www.aapanel.com/docs/Function/php.html",
        "behaviors": [
          "Paste key and certificate, or pick from the certificate store",
          "ACME via HTTP file check or DNS (manual TXT or provider API); wildcard via DNS",
          "Force HTTPS toggle and TLS version choice",
          "Shows issuer, domains and expiry; renew; disable",
          "Auto-renew except for manually validated DNS certificates"
        ]
      }
    ]
  },
  {
    "id": "ssl-tls-status",
    "behaviors": [
      "Search by domain; filters by domain type (main, sub, addon, parked, www/mail, service subdomains, dynamic DNS), certificate type (unsecured, self-signed, auto DV, DV, OV, EV), status (active, expired, expiring soon, unsecured, auto problems) and auto inclusion",
      "Per-domain status with last auto run and error text",
      "View certificate link",
      "Run auto-certificate check now; include or exclude domains",
      "CAA records can block issuance (fix in DNS editor)",
      "TLS 1.2 default, 1.3 supported"
    ],
    "acceptance": "A domain with no certificate appears under the 'unsecured' filter; after excluding it and running a check, no certificate is requested for it; a domain that does not resolve to a public IP shows an auto-problem entry with a DCV failure reason.",
    "source": "https://docs.cpanel.net/cpanel/security/ssl-tls-status/",
    "upstreamFeatureKey": "AutoSSL",
    "upstreamAcl": "",
    "upstreamApi": "SSL::start_autossl_check, SSL::is_autossl_check_in_progress, SSL::get_autossl_problems, SSL::get_autossl_excluded_domains, SSL::add_autossl_excluded_domains, SSL::remove_autossl_excluded_domains, SSL::set_autossl_excluded_domains, SSL::get_autossl_renewal_status, DCV::check_domains_via_http, DCV::check_domains_via_dns",
    "absorbed": [
      {
        "id": "ssl-unified-settings",
        "name": "SSL/TLS Certificates (Unified View and Default Key Type)",
        "source": "https://docs.cpanel.net/cpanel/security/ssl-tls-certificates/",
        "behaviors": [
          "Tabs: certificates, keys, requests, installation, status, settings (purchase tab excluded in our build)",
          "Default key type for new keys/CSRs/auto certificates, overriding the server default",
          "Saving a new default triggers an auto-certificate run that reissues auto certificates with the new type"
        ]
      }
    ]
  },
  {
    "id": "ssl-tls-wizard",
    "behaviors": [
      "Requires vendor account login and store checkout",
      "Pending certificate tracking"
    ],
    "acceptance": "Not built; status page offers no purchase link.",
    "source": "https://docs.cpanel.net/cpanel/security/ssl-tls-wizard/",
    "upstreamFeatureKey": "SSL/TLS Wizard",
    "upstreamAcl": "",
    "upstreamApi": "Market::*",
    "absorbed": []
  },
  {
    "id": "api-tokens",
    "behaviors": [
      "Name up to 50 chars of letters, digits, dash, underscore; unique",
      "Expiry: never or a date (default one year ahead), effective end of that day server time; not editable later",
      "Optional read-only flag: write calls rejected",
      "Secret displayed once at creation; must be recreated if lost",
      "Table: name, created, expires; expiring soon and expired highlighted; expired tokens kept until deleted",
      "Rename; revoke single or bulk with confirmation",
      "Tokens limited to the account's enabled features; used via an Authorization header of the form 'cpanel user:TOKEN'"
    ],
    "acceptance": "Name 'my token' returns VALIDATION_ERROR; a created token's secret appears only in the create response and never in list output; a call with a revoked or expired token returns 401; a read-only token calling a write function returns 403.",
    "source": "https://docs.cpanel.net/cpanel/security/manage-api-tokens-in-cpanel/",
    "upstreamFeatureKey": "apitokens (Manage API Tokens)",
    "upstreamAcl": "",
    "upstreamApi": "Tokens::create_full_access, Tokens::list, Tokens::rename, Tokens::revoke",
    "absorbed": []
  },
  {
    "id": "hotlink-protection",
    "behaviors": [
      "Enable/disable; disabling clears the allowed-referrer list (warn to save it)",
      "Allowed referrer URLs (one per line); include own domains and subdomains",
      "Protected file extensions (comma separated)",
      "Allow requests with no referrer (direct typing)",
      "Redirect URL for blocked requests"
    ],
    "acceptance": "With .jpg protected, example.com allowed and a redirect URL set, a GET for /a.jpg with Referer https://evil.test is redirected to that URL, with Referer https://example.com returns 200, and with no Referer returns 200 only when 'allow direct' is on.",
    "source": "https://docs.cpanel.net/cpanel/security/hotlink-protection/",
    "upstreamFeatureKey": "Hotlink Protection",
    "upstreamAcl": "",
    "upstreamApi": "Mime::add_hotlink, Mime::list_hotlinks, Mime::delete_hotlink",
    "absorbed": [
      {
        "id": "aapanel-hotlink",
        "name": "Hotlink Protection",
        "source": "https://www.aapanel.com/docs/Function/php.html",
        "behaviors": [
          "Protected extensions",
          "Allowed referrer domains",
          "Response for other referrers",
          "Toggle for empty referrer"
        ]
      }
    ]
  },
  {
    "id": "leech-protection",
    "behaviors": [
      "Folder browser starting at web root or a domain's document root",
      "Max logins per username per two hours",
      "Redirect URL for offenders",
      "Optional alert email",
      "Optional automatic disabling of offending users",
      "Enable / disable per folder; link to the folder's protected users",
      "Requires the folder to be password protected"
    ],
    "acceptance": "With limit 3 on /members, a 4th login by the same user from a new IP within two hours is redirected to the configured URL, an alert email is queued when set, and with auto-disable on the user's next valid login is refused.",
    "source": "https://docs.cpanel.net/cpanel/security/leech-protection/",
    "upstreamFeatureKey": "Leech Protect",
    "upstreamAcl": "",
    "upstreamApi": "LeechProtect::setup (API 2)",
    "absorbed": []
  },
  {
    "id": "security-policy",
    "behaviors": [
      "Set or update security questions and answers with confirm step",
      "Root-level sessions can only reset them (user re-prompted at next login)",
      "Trusted IP list: add single IP or range (last-octet wildcard), remove",
      "Login from an untrusted IP prompts questions; a correct answer trusts that IP",
      "Shown only when the host enables the policy"
    ],
    "acceptance": "With the policy on, a login from an untrusted IP is challenged with a security question; a correct answer completes login and adds the IP to the trusted list so the next login from it is not challenged; a wrong answer returns AUTH_CHALLENGE_FAILED.",
    "source": "https://docs.cpanel.net/cpanel/security/security-policy/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "modsecurity",
    "behaviors": [
      "Enable all / disable all (disable needs confirmation)",
      "Per-domain on/off once enabled globally",
      "Recommendation to keep on and only disable during troubleshooting",
      "Requires the WAF module and the domain-manager feature"
    ],
    "acceptance": "With WAF off for a.example and on for b.example, a request carrying a standard SQL-injection test payload reaches the app on a.example but gets 403 on b.example; enabling a domain not owned by the account returns FORBIDDEN.",
    "source": "https://docs.cpanel.net/cpanel/security/modsecurity/",
    "upstreamFeatureKey": "ModSecurity Domain Manager",
    "upstreamAcl": "",
    "upstreamApi": "ModSecurity::list_domains, ModSecurity::enable_domains, ModSecurity::disable_domains, ModSecurity::enable_all_domains, ModSecurity::disable_all_domains, ModSecurity::has_modsecurity_installed",
    "absorbed": []
  },
  {
    "id": "two-factor-auth",
    "behaviors": [
      "Setup shows QR code (otpauth URL) and manual account/secret values",
      "User confirms with the current 6-digit code; time drift on the server causes invalid-code errors",
      "Login then requires password plus code",
      "Reconfigure replaces the secret and logs out other sessions",
      "Remove returns to password-only",
      "No self-service recovery; host can clear it",
      "Password-based API calls can bypass it unless the host enforces policy; tokens unaffected"
    ],
    "acceptance": "Submitting a wrong 6-digit code during setup returns INVALID_TOTP and 2FA stays off; after setup, login with only the password is refused; after reconfigure, codes from the old secret fail and other active sessions are terminated.",
    "source": "https://docs.cpanel.net/cpanel/security/two-factor-authentication-for-cpanel/",
    "upstreamFeatureKey": "Two-Factor Authentication",
    "upstreamAcl": "",
    "upstreamApi": "TwoFactorAuth::generate_user_configuration, TwoFactorAuth::set_user_configuration, TwoFactorAuth::get_user_configuration, TwoFactorAuth::remove_user_configuration",
    "absorbed": []
  },
  {
    "id": "imunify360",
    "behaviors": [
      "Vendor plugin UI"
    ],
    "acceptance": "Not built; no tile or route.",
    "source": "https://docs.cpanel.net/whm/packages/feature-manager/",
    "upstreamFeatureKey": "Imunify360",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "php-pear-packages",
    "behaviors": [
      "Shows the account's private include path for user-installed PEAR packages and a ready-to-paste snippet that adds that path to a PHP script",
      "Install by exact package name, by keyword search against the PEAR channel, or by browsing the full list of available packages (name, version, description, install action)",
      "Installed packages table with name and version, plus actions to update, reinstall, uninstall and open the package documentation",
      "Separate read-only list of system-provided packages, which the user cannot remove",
      "Install and uninstall run as the account user and only write inside the account's home directory"
    ],
    "acceptance": "Installing the PEAR package 'Config_Lite' puts it under the account's private PEAR path and it appears in the installed list; trying to uninstall a system-provided package returns SYSTEM_MODULE_PROTECTED; when the plan lacks modules-php-pear, every endpoint returns FEATURE_DISABLED.",
    "source": "https://docs.cpanel.net/cpanel/software/php-pear-packages/",
    "upstreamFeatureKey": "modules-php-pear",
    "upstreamAcl": "",
    "upstreamApi": "LangMods (cPanel API 2, lang=php-pear: install, uninstall, update, list_installed, list_available, search, setup, getprefix)",
    "absorbed": []
  },
  {
    "id": "perl-modules",
    "behaviors": [
      "Shows the account's module include path and the line a Perl script needs to load modules from it",
      "Install by exact module name, by keyword search, or by browsing a list of CPAN modules (not the whole CPAN index)",
      "Installed modules table with name, version and actions to update, reinstall from CPAN, uninstall and view the CPAN documentation",
      "Button that lists the system-installed Perl modules, which are read-only",
      "Modules must be installed before scripts can use them; installation is limited to the account's home directory"
    ],
    "acceptance": "After installing 'JSON::Tiny', a CGI script that adds the shown include path loads the module without error, and the module appears in the installed list with its version; an install request for an empty or malformed module name returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/cpanel/software/perl-modules/",
    "upstreamFeatureKey": "modules-perl",
    "upstreamAcl": "",
    "upstreamApi": "LangMods (cPanel API 2, lang=perl)",
    "absorbed": []
  },
  {
    "id": "optimize-website",
    "behaviors": [
      "Three modes: disabled, compress all content, or compress only the listed MIME types",
      "MIME list is a space-separated text field (for example text/html text/plain text/xml); image formats should not be listed because they are already compressed",
      "Saving writes a panel-managed compression block in the account-level .htaccess and replaces any earlier block",
      "The page is hidden when the web server's compression module is not available",
      "Notes that PHP output compression is controlled separately in the PHP INI editor (zlib.output_compression)"
    ],
    "acceptance": "With mode 'specified types' and 'text/html text/css', a GET for a .css file with Accept-Encoding: gzip returns Content-Encoding: gzip while a .png does not; a malformed token such as 'texthtml' is rejected with VALIDATION_ERROR; switching to 'disabled' removes the managed block.",
    "source": "https://docs.cpanel.net/cpanel/software/optimize-website/",
    "upstreamFeatureKey": "optimizews",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "multiphp-ini-editor",
    "behaviors": [
      "Target selector: Home Directory (applies to all sites) or a specific domain",
      "Basic mode: form of common directives with toggles and values; only directives supported by the selected PHP version are shown; apply writes to php.ini, .user.ini and .htaccess where each supports the directive",
      "Editor mode: raw text editor of the target php.ini; opens empty when no file exists so the user can create one",
      "Rejects directive names that are reserved words (null, yes, no, true, false, on, off, none) and names containing special characters such as ? { } | & ~ ! [ ( ) ^ or double quote",
      "Basic name validation only; deleting the php.ini resets the target to defaults",
      "Shows the file path being edited"
    ],
    "acceptance": "Saving memory_limit = 256M for example.com makes ini_get('memory_limit') on that domain return 256M while other domains keep their value; a directive named 'yes' or containing '{' is rejected with VALIDATION_ERROR; type=vhost without a vhost name returns MISSING_PARAMETER.",
    "source": "https://docs.cpanel.net/cpanel/software/multiphp-ini-editor-for-cpanel/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "LangPHP (php_ini_get_user_basic_directives, php_ini_set_user_basic_directives, php_ini_get_user_content, php_ini_set_user_content, php_ini_get_user_paths)",
    "absorbed": []
  },
  {
    "id": "application-manager",
    "behaviors": [
      "Applications table: name, domain, path relative to home, enabled/disabled status, and actions (edit, unregister, install dependencies)",
      "Register form: app name, deployment domain (main, addon or subdomain), base URL path, source path relative to home, environment (development or production), optional environment variables, then deploy",
      "Environment variable rules: name uses letters, digits, underscore and dash only, is at most 256 characters and does not start with a digit; value is at most 1024 printable ASCII characters",
      "Edit any field and redeploy; editing env vars replaces the whole set",
      "Enable/disable an app (on regenerates the web server config for it)",
      "Unregister removes the app from the list and deletes its server config but leaves the source files",
      "Install dependencies runs npm, pip or gem against package.json, requirements.txt or Gemfile",
      "Log locations: Node apps under <app>/logs/, Python apps in <app>/stderr.log",
      "Hidden unless the server has the app-server module and at least one runtime installed"
    ],
    "acceptance": "Registering an app with an environment variable named '1TOKEN' returns VALIDATION_ERROR; a valid registration at example.com/app serves the app's response at that URL; unregistering it makes the URL stop routing to the app while the source directory still exists on disk.",
    "source": "https://docs.cpanel.net/cpanel/software/application-manager/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "PassengerApps (register_application, edit_application, list_applications, enable_application, disable_application, unregister_application, ensure_deps)",
    "absorbed": []
  },
  {
    "id": "web-apps",
    "behaviors": [
      "Capacity view: how many apps the account may run and which runtimes and version tags are available",
      "Stage from Git (optional branch and SSH key) or from an uploaded zip/tar archive; optional app subfolder for monorepos; a name collision gets a -N suffix",
      "Preflight detects framework and category (static or server) and suggests defaults with a confidence level; staging never deploys",
      "Configure: domain (new subdomain of an owned domain; a domain used by another app is refused), build command, start command, output directory, runtime version tag, environment as JSON or pasted .env text (both replace the whole set; not both at once)",
      "Deploy runs asynchronously with live progress; status goes deploying -> running or errored; a repeated deploy while one is running returns the running task",
      "Start, stop, restart, redeploy, switch run mode (production/development) for server apps, fetch app or build logs (last N lines), delete",
      "Supersedes Application Manager for new apps; Application Manager remains for apps already registered there"
    ],
    "acceptance": "Staging a Git source registers the app with status 'staged' and nothing served on its domain; deploy moves it to 'running' (or 'errored' with a failure category); calling set_mode on a static app returns INVALID_CATEGORY; sending both env and env_text returns VALIDATION_ERROR.",
    "source": "https://api.docs.cpanel.net/specifications/cpanel.openapi/web-apps/webapp-stage",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "WebApp (get_available, has_feature, stage, configure, deploy, redeploy, start, stop, restart, set_mode, fetch_logs, list, delete)",
    "absorbed": []
  },
  {
    "id": "site-software",
    "behaviors": [
      "Toggle for email notices about available updates",
      "Per-addon tabs: install (quick, or advanced with URL, admin user, password, email), manage installed instances, upgrade an instance, uninstall an instance",
      "Extra info: version details, license terms, security notes"
    ],
    "acceptance": "Not implemented: the route /software/site-software returns NOT_FOUND and no feature key is offered in plans.",
    "source": "https://docs.cpanel.net/cpanel/software/site-software/",
    "upstreamFeatureKey": "addoncgi",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "rubygems",
    "behaviors": [
      "Installed gems table with name, version, update, reinstall, uninstall and docs actions",
      "Install a gem by name"
    ],
    "acceptance": "Not implemented; Ruby dependencies install through the Application Manager install-dependencies action (type=gem).",
    "source": "https://docs.cpanel.net/cpanel/software/rubygems/",
    "upstreamFeatureKey": "modules-ruby",
    "upstreamAcl": "",
    "upstreamApi": "LangMods (cPanel API 2, lang=ruby)",
    "absorbed": []
  },
  {
    "id": "ruby-on-rails",
    "behaviors": [
      "Each new app gets the next free port",
      "Create, edit or delete a rewrite that maps a domain or path to an app port",
      "Admin can cap the number of Rails apps per account"
    ],
    "acceptance": "Not implemented; Ruby apps are registered through Application Manager.",
    "source": "https://docs.cpanel.net/cpanel/software/ruby-on-rails/",
    "upstreamFeatureKey": "ror",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "php-version-selector",
    "behaviors": [
      "Only appears on CloudLinux servers with the CloudLinux Manager plugin"
    ],
    "acceptance": "Not implemented; MultiPHP Manager and MultiPHP INI Editor cover PHP version and settings.",
    "source": "https://docs.cpanel.net/whm/packages/feature-manager/",
    "upstreamFeatureKey": "php-version-selector",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "multiphp-manager",
        "name": "MultiPHP Manager",
        "source": "https://docs.cpanel.net/cpanel/software/multiphp-manager-for-cpanel/",
        "behaviors": [
          "Domain list with domain name, current PHP version, an 'inherited' marker when it follows the server default, and a PHP-FPM on/off indicator; searchable by domain",
          "Select one or more domains and apply a version from a menu of versions that are installed and allowed for the plan; admin-recommended versions carry a 'recommended' label",
          "'inherit' option makes the domain follow the server-wide default set by the admin",
          "PHP-FPM cannot be turned on while the domain uses 'inherit'; when FPM is on, changing the version also moves the FPM pool to the new version",
          "A change on a domain that shares a document root with other domains applies to all of them",
          "If the primary domain is renamed while FPM is on, FPM is turned off for the new name and must be turned on again by the admin",
          "Plan-level permissions decide which PHP versions an account may choose (one permission per installed version)"
        ]
      },
      {
        "id": "aapanel-site-php-version",
        "name": "Site PHP Version",
        "source": "https://www.aapanel.com/docs/Function/php.html",
        "behaviors": [
          "Choose from installed versions or static",
          "Applies immediately"
        ]
      },
      {
        "id": "aapanel-subpanel-php",
        "name": "End-User PHP Manager",
        "source": "https://www.aapanel.com/docs/SubaaPanel/PHP.html",
        "behaviors": [
          "List installed versions with the number of sites using each",
          "Service control, extensions, disabled functions, common parameters, run log and slow log",
          "Uninstalling a version that a site uses is blocked"
        ]
      }
    ]
  },
  {
    "id": "nodejs-apps",
    "behaviors": [
      "Only appears on CloudLinux servers; our version is Application Manager / Web Apps with the Node.js runtime"
    ],
    "acceptance": "Not implemented; a Node.js app registered through Application Manager serves traffic on its base URL.",
    "source": "https://docs.cpanel.net/whm/packages/feature-manager/",
    "upstreamFeatureKey": "nodejs-apps",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "aapanel-nodejs-project",
        "name": "Node.js Projects",
        "source": "https://www.aapanel.com/docs/Function/Node.html",
        "behaviors": [
          "Create a project from a directory, optionally pulling from git; run a package.json script or a custom command; set the port and run user (root or web user) and pick a Node version",
          "Process-manager mode with a cluster instance count and a memory limit that triggers an automatic restart",
          "Bind domains and map them to the project, with URL rewrite, server config and SSL available once mapping is on",
          "Start, stop and restart; show PID, CPU and RAM; view the project log and site logs"
        ]
      }
    ]
  },
  {
    "id": "python-apps",
    "behaviors": [
      "Only appears on CloudLinux servers; our version is Application Manager (WSGI via the app server, pip dependencies)"
    ],
    "acceptance": "Not implemented; a WSGI app registered in Application Manager with requirements.txt gets its dependencies through the pip install-dependencies action.",
    "source": "https://docs.cpanel.net/whm/packages/feature-manager/",
    "upstreamFeatureKey": "python-apps",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "aapanel-python-project",
        "name": "Python Projects",
        "source": "https://www.aapanel.com/docs/Function/python.html",
        "behaviors": [
          "Startup mode: uWSGI, Gunicorn or a custom command",
          "Install one package, or install from requirements.txt into the project's own environment",
          "Open a terminal already inside the virtual environment",
          "Map a domain to 80 and 443 with SSL, and view the project log"
        ]
      }
    ]
  },
  {
    "id": "ruby-apps",
    "behaviors": [
      "Only appears on CloudLinux servers"
    ],
    "acceptance": "Not implemented; Ruby apps go through Application Manager.",
    "source": "https://docs.cpanel.net/whm/packages/feature-manager/",
    "upstreamFeatureKey": "ruby-apps",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "cloudlinux-acceleratewp-xray",
    "behaviors": [
      "Only appear on CloudLinux servers"
    ],
    "acceptance": "Not implemented; these feature names never appear in our feature lists.",
    "source": "https://docs.cpanel.net/whm/packages/feature-manager/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "softaculous",
    "behaviors": [
      "Comes from a third-party plugin, not from the core panel"
    ],
    "acceptance": "Not implemented.",
    "source": "https://docs.cpanel.net/whm/packages/feature-manager/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "installatron",
    "behaviors": [
      "Comes from a third-party plugin installed by the server admin"
    ],
    "acceptance": "Not implemented.",
    "source": "https://support.cpanel.net/hc/en-us/articles/4410628141079-How-to-install-Installatron",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "terminal",
    "behaviors": [
      "Shown only when the account has shell access and the plan includes the shell/terminal feature; the server profile can also hide it",
      "First use shows a risk warning that must be accepted; the acceptance is remembered so it is not shown again",
      "Session runs as the unprivileged account user in the account's home, never as root",
      "Ending a session closes the terminal; a Reconnect button opens a new one",
      "After panel logout, open terminal sessions close shortly afterwards; commands still running keep going until their session closes"
    ],
    "acceptance": "With shell access off or the ssh feature missing from the plan, opening a terminal returns FEATURE_DISABLED and no PTY is created; with it on, running 'id -un' prints the account username and 'id -u' is not 0; logging out of the panel closes the session within 60 seconds.",
    "source": "https://docs.cpanel.net/cpanel/advanced/terminal-in-cpanel/",
    "upstreamFeatureKey": "ssh",
    "upstreamAcl": "",
    "upstreamApi": "SSH::get_shell (shell status); terminal transport is internal",
    "absorbed": [
      {
        "id": "aapanel-file-terminal-here",
        "name": "Open Terminal Here",
        "source": "https://www.aapanel.com/docs/Function/Files.html",
        "behaviors": [
          "Launch a terminal that starts in the current folder"
        ]
      }
    ]
  },
  {
    "id": "cron-jobs",
    "behaviors": [
      "Cron email field: one address receives the output of all jobs; clearing it turns output mail off for every job; one job can be silenced by sending its output to /dev/null",
      "Add job: minute, hour, day of month, month and weekday fields plus a command, all required; a 'common settings' menu fills the five fields with typical schedules (for example once per hour)",
      "Weekday accepts 0-7 with 0 and 7 both meaning Sunday",
      "Current jobs table with schedule and command; edit a line in place; delete with confirmation",
      "Interface warns about overlapping runs and destructive commands and suggests absolute paths; scripts need the execute bit"
    ],
    "acceptance": "Adding a job with weekday '8', minute '61' or an empty command returns VALIDATION_ERROR; a valid job '*/5 * * * * /home/u/run.sh' appears exactly once in the account's crontab and in the list; deleting it removes the line; setting the cron email writes MAILTO for that user only.",
    "source": "https://docs.cpanel.net/cpanel/advanced/cron-jobs/",
    "upstreamFeatureKey": "cron",
    "upstreamAcl": "",
    "upstreamApi": "Cron (cPanel API 2: add_line, edit_line, remove_line, listcron, fetchcron, get_email, set_email)",
    "absorbed": []
  },
  {
    "id": "track-dns",
    "behaviors": [
      "Domain lookup: enter a host name and get its IP addresses, MX hosts and a zone information section",
      "Trace route: one click runs a route trace between the server and the visitor's address and shows each hop with timing",
      "The admin can withhold trace route; then the page explains it is unavailable"
    ],
    "acceptance": "Looking up 'example.com' returns arrays of A/AAAA and MX answers; input 'bad..name' or one longer than 253 characters returns VALIDATION_ERROR; when trace route is turned off by the admin, the trace endpoint returns FEATURE_DISABLED.",
    "source": "https://docs.cpanel.net/cpanel/advanced/track-dns/",
    "upstreamFeatureKey": "nettools",
    "upstreamAcl": "",
    "upstreamApi": "DNS::lookup (UAPI); Net::traceroute and DnsLookup::name2ip (cPanel API 2)",
    "absorbed": []
  },
  {
    "id": "indexes",
    "behaviors": [
      "Start location picker: home directory, primary web root, or a chosen domain's document root, with an option to always open there",
      "Directory browser with folder navigation, up one level and home shortcuts",
      "Per-directory option: inherit from parent (or server default), no listing (visitors get forbidden), names only, or names with details such as size and type",
      "Current setting shown in an index type column for each directory"
    ],
    "acceptance": "Setting 'disabled' on public_html/files makes GET /files/ (no index file present) return 403; setting 'fancy' returns a listing that includes file sizes; 'inherit' removes the managed directive; a path outside the account's home returns PATH_OUTSIDE_HOME.",
    "source": "https://docs.cpanel.net/cpanel/advanced/indexes/",
    "upstreamFeatureKey": "indexmanager",
    "upstreamAcl": "",
    "upstreamApi": "DirectoryIndexes (list_directories, get_indexing, set_indexing with type inherit|disabled|standard|fancy)",
    "absorbed": []
  },
  {
    "id": "error-pages",
    "behaviors": [
      "Domain selector when the account has more than one domain",
      "Shortlist of common error codes plus a tab listing every HTTP error status code",
      "Editor for the page content, with buttons that insert visitor details (for example requested URL, referring page, visitor IP, browser) and support for extra HTML",
      "Save stores the page and wires it as that domain's handler for the code",
      "Default server pages are used for codes without a custom page"
    ],
    "acceptance": "After saving a custom 404 page for example.com, GET https://example.com/does-not-exist returns status 404 with the custom body and the inserted requested-URL tag shows the real path; saving a code outside 400-599 returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/cpanel/advanced/error-pages/",
    "upstreamFeatureKey": "errpgs",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "apache-handlers",
    "behaviors": [
      "Add form: handler name plus one or more extensions separated by spaces",
      "Only built-in handlers are accepted: default-handler, send-as-is, cgi-script, imap-file, server-info, server-parsed, server-status, type-map; custom handler names are refused",
      "User-defined handlers table with delete (confirmation); system handler mappings are listed read-only and cannot be removed"
    ],
    "acceptance": "Adding handler 'my-handler' returns INVALID_HANDLER; adding 'server-parsed' for '.html' makes an .html page with an SSI include render the included text and list_handlers(type=user) returns the mapping; deleting a system mapping returns FORBIDDEN.",
    "source": "https://docs.cpanel.net/cpanel/advanced/apache-handlers/",
    "upstreamFeatureKey": "handlers",
    "upstreamAcl": "",
    "upstreamApi": "Mime (add_handler, delete_handler, list_handlers type=system|user)",
    "absorbed": []
  },
  {
    "id": "mime-types",
    "behaviors": [
      "Add form: MIME type (type/subtype) plus one or more extensions",
      "User-defined types table with delete and a confirmation step",
      "System MIME types table is read-only"
    ],
    "acceptance": "Adding 'text/foo' for '.foo' makes GET /x.foo return Content-Type: text/foo; a type without a slash such as 'textfoo' returns VALIDATION_ERROR; deleting a system type returns FORBIDDEN.",
    "source": "https://docs.cpanel.net/cpanel/advanced/mime-types/",
    "upstreamFeatureKey": "mime",
    "upstreamAcl": "",
    "upstreamApi": "Mime (add_mime, delete_mime, list_mime type=system|user)",
    "absorbed": []
  },
  {
    "id": "virus-scanner",
    "behaviors": [
      "Scan targets (only those the admin allows): mail folders, the whole home directory, the public FTP area, the public web area",
      "Progress view: files scanned out of total, data scanned out of total, a progress bar and a growing infected-files list",
      "Per infected file choose an action: delete, quarantine, ignore, or cleanse the mailbox (for mail hits); then track disinfection until done",
      "Hidden unless the server has the antivirus engine and its panel plugin installed"
    ],
    "acceptance": "Scanning public_html that contains the EICAR test file lists that file as infected; choosing 'quarantine' moves it out of public_html into the account quarantine folder and disinfection status reaches 'done'; a scan_type outside the allowed set returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/cpanel/advanced/virus-scanner/",
    "upstreamFeatureKey": "clamavconnector_scan",
    "upstreamAcl": "",
    "upstreamApi": "ClamScanner (get_scan_paths, start_scan scan_type=home|mail|public_html|public_ftp, get_scan_status, list_infected_files, disinfect_files, check_disinfection_status)",
    "absorbed": []
  },
  {
    "id": "api-shell",
    "behaviors": [
      "Available only to reseller-owned/reseller accounts, and only when the server-wide developer switch and the plan feature are both on",
      "Pick API version and function, then add or remove key/value parameters",
      "Optional result shaping: first-result index and max results (0 means unlimited), filters (contains, begins with, equals, greater than, less than), sorts (text, numeric, numeric with zero as max, IPv4, reverse) and column selection",
      "Live preview of the request URL and payload as fields change",
      "Response shown as tree, table (when the data allows) and raw with headers separated from body",
      "Warns that calls change real data"
    ],
    "acceptance": "A non-reseller account calling the API shell endpoint gets FORBIDDEN; for a reseller, running a list function with max results 2 returns exactly two records, and the raw tab shows the HTTP headers apart from the JSON body.",
    "source": "https://docs.cpanel.net/cpanel/advanced/api-shell-for-cpanel/",
    "upstreamFeatureKey": "api_shell",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "account-preferences",
    "behaviors": [
      "Contact section: primary and secondary email addresses; saving requires the account password",
      "Contact preferences: the same notification switches as Contact Information, including AutoSSL notice level",
      "System notification position: choose where on the screen notices appear (default top-right; a centered option shows an overlay closed with Esc or X); applies to every page",
      "Language menu with save",
      "Change password with a generator (length and character classes; generated passwords up to 18 characters)",
      "Each section appears only when the related feature is on for the plan"
    ],
    "acceptance": "Changing the primary contact email with a wrong account password returns INVALID_PASSWORD and keeps the old address; setting notification position to 'bottom-left' persists across logout/login and is applied on every page.",
    "source": "https://docs.cpanel.net/cpanel/preferences/account-preferences/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "ContactInformation, Locale, Users::change_password, Personalization",
    "absorbed": [
      {
        "id": "contact-information",
        "name": "Contact Information",
        "source": "https://docs.cpanel.net/cpanel/preferences/contact-information/",
        "behaviors": [
          "Up to two contact email addresses; changing them requires the account password; the stored old value is checked to avoid overwriting a concurrent change",
          "Optional push-notification access token",
          "Notice switches: contact address changed (sent to old and new), that notice turned off, disk quota nearly full, bandwidth limit nearly reached (only when limited), non-AutoSSL certificate expiring, any mailbox near or over quota, password changed, that notice turned off, successful login, login notices even from known IP ranges, login notices turned off, external account linked, that notice turned off",
          "Login notices need brute-force protection on the server; at most one per 24 hours per user, service and IP; whitelisted IPs never trigger it",
          "AutoSSL notice level: all events, failures and deferrals (default), failures only, or none; not offered to webmail users",
          "Advice not to use an address hosted on the same account; a contact address is required for password reset"
        ]
      }
    ]
  },
  {
    "id": "password-security",
    "behaviors": [
      "Change password: current password plus new password; this changes the panel login, not mailbox passwords",
      "Strength meter scored 0-100 against the minimum strength set by the admin",
      "Generator window: regenerate, set length and include upper case, lower case, digits, symbols; must tick 'I copied it' before using it; generated passwords up to 18 characters, manual ones unlimited",
      "Option for Web Disk digest authentication on plain-text connections",
      "External authentication tab (only when the admin configured providers): list linked OpenID Connect identities, link a new one through the provider's login, unlink one after confirmation",
      "Team users use the same page for their own password"
    ],
    "acceptance": "A change with a wrong current password returns INVALID_PASSWORD; a new password scoring below the required strength returns WEAK_PASSWORD; after a successful change the old password no longer logs in and the new one does.",
    "source": "https://docs.cpanel.net/cpanel/preferences/password-and-security/",
    "upstreamFeatureKey": "password",
    "upstreamAcl": "",
    "upstreamApi": "Users::change_password (newpass, oldpass, enabledigest, enablemysql); PasswdStrength::get_required_strength; ExternalAuthentication (configured_modules, get_authn_links, remove_authn_link)",
    "absorbed": []
  },
  {
    "id": "change-language",
    "behaviors": [
      "Menu of available locales; change reloads the interface in the new language",
      "Choice is saved for the user; webmail also keeps it in a browser cookie that lasts about a year",
      "Login screen has its own language picker and falls back to the browser's Accept-Language, then English",
      "Team users inherit the owner's language until they set their own",
      "Marked as deprecated in favour of Account Preferences"
    ],
    "acceptance": "Setting locale 'ar' makes the next page render with dir=rtl and Arabic labels; an unknown locale code 'xx' returns VALIDATION_ERROR; a team user without their own setting shows the owner's locale.",
    "source": "https://docs.cpanel.net/cpanel/preferences/change-language/",
    "upstreamFeatureKey": "setlang",
    "upstreamAcl": "",
    "upstreamApi": "Locale (list_locales, set_locale, get_attributes)",
    "absorbed": []
  },
  {
    "id": "user-manager",
    "behaviors": [
      "List of subaccounts with their enabled services; the owner account and the logs account are marked special and cannot be edited or deleted",
      "Add user: full name, username (letters, digits, dot, dash, underscore), domain, contact email, and either an emailed set-your-password link or a password set now (strength meter and generator)",
      "Services: email with quota (unlimited unless the plan sets a maximum; hard ceiling about 4 PB), FTP with quota and home directory (default under public_html), Web Disk with home directory, read-write or read-only, and optional digest auth",
      "Detects existing email, FTP or Web Disk accounts with the same username and offers to link them into one subaccount or dismiss the suggestion",
      "Edit name, contact email, password and services; delete removes the subaccount and all its services",
      "Email services are refused on temporary domains"
    ],
    "acceptance": "Creating subaccount 'bob' on example.com with email and FTP creates mailbox bob@example.com and FTP login bob@example.com that both accept the same password; an email quota above the plan maximum returns LIMIT_EXCEEDED; a username with a space returns VALIDATION_ERROR; logging into the panel as bob is refused.",
    "source": "https://docs.cpanel.net/cpanel/preferences/user-manager/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "UserManager (list_users, lookup_user, create_user, edit_user, delete_user, change_password, check_account_conflicts, merge_service_account, dismiss_merge, unlink_service_account)",
    "absorbed": []
  },
  {
    "id": "manage-team",
    "behaviors": [
      "Team list: username (with a suspended marker), roles, last login, services, actions; detail view shows restriction info, notes, creation date, roles and contact email",
      "Roles: administrator (everything except calendar/contacts pages, User Manager and Manage Team), database, email, web; several roles can be combined; a user without a role can only edit their own password, language and contact info",
      "Limit on how many team users may hold a role (default 7; only the server admin can lower it); role-less users are unlimited",
      "Create: username shown as user@primary-domain, set password or email an activation link, contact email, roles, a required security acknowledgement, notes up to 100 characters, services (email quota, FTP quota/home, Web Disk home/permissions/digest), optional expiry date and reason up to 100 characters",
      "Edit the same fields; set expiry with optional email to the user",
      "Suspend with a reason and unsuspend; a suspended user cannot sign in, cannot have the password changed and still counts toward the role limit",
      "Delete is permanent and frees a role slot",
      "Each team user gets a virtual database user named owner_teamuser that follows the team user's suspend/reinstate/delete state"
    ],
    "acceptance": "Adding an 8th team user with a role when the limit is 7 returns LIMIT_EXCEEDED; a team user holding only the 'email' role who calls a database function gets FORBIDDEN; suspending a team user blocks their login and suspends the matching owner_teamuser database user.",
    "source": "https://docs.cpanel.net/cpanel/preferences/manage-team/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Team (list_team, add_team_user, edit_team_user, remove_team_user, suspend_team_user, reinstate_team_user, set_roles, add_roles, remove_roles, set_password, set_expire, cancel_expire, set_notes, set_contact_email, set_locale, get_team_users_with_roles_count, password_reset_request); TeamRoles::list_feature_descriptions",
    "absorbed": []
  },
  {
    "id": "team-audit-log",
    "behaviors": [
      "Table columns: time, caller (owner or team user), API version, function called, origin (interface or command line)",
      "Search box, column sorting and paging",
      "Only calls that go through the API are recorded",
      "Requires the server admin to switch on API call logging"
    ],
    "acceptance": "After team user 'sam' creates a mailbox through the interface, the audit log has one new entry with caller sam, the mailbox-create function and origin 'ui'; with API logging off, the page shows a disabled notice and the endpoint returns FEATURE_DISABLED.",
    "source": "https://docs.cpanel.net/cpanel/preferences/manage-team-audit-log/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "change-style",
    "behaviors": [
      "Theme menu in the general information area listing the themes allowed for the account, with the current one marked",
      "Switching applies on the next page load and only changes the look, not features",
      "Plan permission controls whether the menu is shown at all",
      "Accounts created on the newest theme may be locked to it (the admin can still move them)",
      "Legacy style picker offered several color styles with apply/current markers"
    ],
    "acceptance": "With theme switching off in the plan, PUT /me/theme returns FEATURE_DISABLED; switching to an allowed theme changes the rendered theme on the next request; a theme name not in Themes::list returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/cpanel/the-cpanel-interface/the-cpanel-interface/",
    "upstreamFeatureKey": "style",
    "upstreamAcl": "",
    "upstreamApi": "Themes (list, update, get_theme_base)",
    "absorbed": []
  },
  {
    "id": "interface-analytics-consent",
    "behaviors": [
      "Allow-tracking checkbox in Account Preferences",
      "Effective only when server level and account level are both enabled"
    ],
    "acceptance": "Not implemented; xPanel sends no usage telemetry to third parties.",
    "source": "https://docs.cpanel.net/cpanel/preferences/account-preferences/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "list-accounts",
    "behaviors": [
      "Search box plus a 'search by' selector: username-or-domain, domain, username, owner/reseller, package, IP address; substring match in the UI (the API also offers exact or regex matching)",
      "Filter selector: none, suspended only, or upgrade opportunity (accounts near or over disk/bandwidth limits; API default 'near' threshold is 80%)",
      "Columns include domain (opens the site), one-click login into the user panel, IP, contact email (mailto), package (links to Edit Package; accounts without a valid package are flagged 'Unknown'), username, owner, disk used/limit, partition, start date, theme, suspension state",
      "Row expand actions: change password (optional DB-password sync, Digest Auth toggle), change contact email, suspend (reason required, optional lock so resellers cannot unsuspend), view suspension details and unsuspend (optional keep service proxying), change IP, change disk partition, change quota, change plan, open Modify Account",
      "One-click login creates a short-lived single-sign-on session as that user; hidden when root/reseller logins are disabled by server policy",
      "Export the current result set to CSV",
      "Resellers only see accounts they own; a 'Create account' link appears only for callers holding create-acct"
    ],
    "acceptance": "As reseller R holding list-accts, GET /xwhm/accounts returns only accounts whose owner is R; adding by=package&q=gold returns only accounts on plans whose name contains 'gold'; the CSV export contains exactly the same rows.",
    "source": "https://docs.cpanel.net/whm/account-information/list-accounts/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "list-accts",
    "upstreamApi": "listaccts, accountsummary, get_upgrade_opportunities",
    "absorbed": [
      {
        "id": "aapanel-subpanel-accounts",
        "name": "Sub-Panel Accounts",
        "source": "https://www.aapanel.com/docs/Function/Account.html",
        "behaviors": [
          "Add an account: optionally auto-create the site and mail domain, choose manual or automatic DNS, set username, password, email, expiry, package and storage disk",
          "List with disk and bandwidth used against the maximum, status, expiry and notes",
          "Log in as the user, edit, or delete (which also deletes the user's data)"
        ]
      }
    ]
  },
  {
    "id": "list-parked-domains",
    "behaviors": [
      "Columns: primary domain, owning user, alias domain, actions",
      "Unpark action removes the alias from the account (vhost alias and DNS zone)",
      "'Add to mail config' action lets the alias accept email",
      "Server-wide blocklist file of common/forbidden domains prevents users from parking them",
      "Resellers see only aliases on accounts they own (when the interface is enabled for them)"
    ],
    "acceptance": "Unparking alias b.test from account u1 removes it from u1's domain list and deletes its zone; parking a domain present in the blocked-common-domains list is rejected with DOMAIN_BLOCKED.",
    "source": "https://docs.cpanel.net/whm/account-information/list-parked-domains/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "create_parked_domain_for_user",
    "absorbed": []
  },
  {
    "id": "list-subdomains",
    "behaviors": [
      "Columns: parent domain, owning user, full subdomain name, linked addon or alias domain (blank if none)",
      "Single search box matching domain, user, subdomain, addon domain or alias domain",
      "Alphabetical sort on every column",
      "Unpark action detaches the addon/alias domain from the subdomain"
    ],
    "acceptance": "Searching 'shop' returns every subdomain whose name, owner, parent or linked addon contains 'shop'; a reseller only receives subdomains of accounts it owns.",
    "source": "https://docs.cpanel.net/whm/account-information/list-subdomains/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "list-suspended-accounts",
    "behaviors": [
      "Columns: domain, user, owner (root if no reseller), date/time suspended, reason, locked flag",
      "Unsuspend action with an optional 'retain service proxying' checkbox",
      "Terminate action (permanent, links to Terminate Accounts flow)",
      "Locked suspensions can only be lifted by root or root-level resellers"
    ],
    "acceptance": "A suspension created with lock=true is listed with locked=yes; an unsuspend attempt by its owning reseller returns FORBIDDEN while root succeeds.",
    "source": "https://docs.cpanel.net/whm/account-information/list-suspended-accounts/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "suspend-acct",
    "upstreamApi": "listsuspended, listlockedaccounts, unsuspendacct",
    "absorbed": []
  },
  {
    "id": "show-accounts-over-quota",
    "behaviors": [
      "Columns: user/domain, space used, quota",
      "Filter to a single reseller's accounts",
      "Inline new quota per row in MB or an 'Unlimited' choice, then Save with a success message"
    ],
    "acceptance": "An account using 1100 MB with a 1000 MB quota appears in the list; after saving quota=2000 it no longer appears.",
    "source": "https://docs.cpanel.net/whm/account-information/show-accounts-over-quota/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "quota",
    "upstreamApi": "get_disk_usage, editquota",
    "absorbed": []
  },
  {
    "id": "view-bandwidth-usage",
    "behaviors": [
      "Columns: user, main domain, transferred, limit, percent used",
      "Counts HTTP, FTP, SMTP and POP3/IMAP traffic; alias-domain traffic is rolled into the main domain; zero-traffic subdomains are omitted",
      "Previous/next month navigation",
      "Click a reseller to restrict the view to its accounts",
      "Click a header to sort; clicking again reverses order",
      "Units toggle: always MB or best-fit units",
      "Edit icon jumps to the account's bandwidth limit"
    ],
    "acceptance": "For month 2026-09 the percent column equals round(transferred/limit*100) for limited accounts and is empty for unlimited ones; the previous-month link returns 2026-08 data.",
    "source": "https://docs.cpanel.net/whm/account-information/view-bandwidth-usage/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "show-bandwidth",
    "upstreamApi": "showbw",
    "absorbed": []
  },
  {
    "id": "create-account",
    "behaviors": [
      "Domain: a registered domain, or 'decide later' which assigns a temporary domain (no mail, no DNS editing) that can later be replaced; a leading www. is stripped",
      "Username: suggested from the domain; max 16 chars, lowercase letters/digits, must not start with a digit or with 'test', must be unique and not reserved; first 8 chars must be unique when database prefixing applies",
      "Password + confirmation with 0-100 strength meter checked against the server minimum, plus a generator; contact email",
      "Choose a package (with preview) or enter manual resources (all plan fields) with optional 'save as new package' name and feature list",
      "Settings: dedicated IP (auto or pick a free IP), shell, CGI, Digest Auth, theme, locale, spam filtering and spam box (box requires filtering)",
      "Mail routing: auto-detect, local, backup MX, remote MX; root may route mail to a linked mail node",
      "DNS: per-account DKIM, SPF, DMARC (DMARC needs SPF and DKIM), use registrar nameservers, overwrite existing zones; read-only display of effective nameservers",
      "Reseller section: make the account a reseller and optionally make it own itself",
      "Account enhancement checkboxes and package-extension values when present",
      "Enforces reseller limits (account count, disk/bandwidth totals unless overselling, per-package allow/number); resellers lacking edit-account must pick a package; nameservers must be configured server-wide first",
      "On success shows a summary and a link into the new user panel; skeleton files are copied into the new home"
    ],
    "acceptance": "A reseller with account_limit=2 already owning 2 accounts gets 409 LIMIT_EXCEEDED on POST /xwhm/accounts; usernames '1abc' or 'testsite' get 422 USERNAME_INVALID; dmarc=1 with spf=0 is rejected with DMARC_REQUIRES_SPF_DKIM; a valid request creates the system user, home dir, vhost and DNS zone in one call.",
    "source": "https://docs.cpanel.net/whm/account-functions/create-a-new-account/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "create-acct",
    "upstreamApi": "createacct, verify_new_username, get_password_strength",
    "absorbed": []
  },
  {
    "id": "modify-account",
    "behaviors": [
      "Change primary domain: also renames mail/FTP/WebDisk logins that embed the old domain and remaps DNS; FTP/WebDisk home dirs unchanged; temporary domain can be replaced by a registered one (never the reverse)",
      "Rename username (same rules as creation) with 'rename prefixed databases and DB users' (default on); sites and DBs briefly unavailable; home dir renamed; only root may rename a self-owned reseller",
      "Account owner (reseller) selector (root-level only), contact email, locale, theme, spam filtering toggle (locked when globally forced on)",
      "Mail node selector (root-level only; warn that moving mail back to a parent overwrites mail there)",
      "Resource limits for every plan field; mail quota per address with 'also update existing mailboxes'",
      "Account enhancements checkboxes; privileges: reseller, CGI, shell",
      "DNS: DKIM/SPF/DMARC toggles that create or delete the records in all zones (DMARC requires both others)",
      "Package-extension variables; 'remove missing extensions' cleanup",
      "On save, if values diverge from the assigned package, offer: switch to a matching package, create new package named <oldpackage>_<user>, update the package for all its accounts, detach from any package, or keep (discouraged)",
      "Optionally apply firewall changes during modification"
    ],
    "acceptance": "Changing maxaddon on an account assigned to 'basic' returns PACKAGE_CONFLICT listing the five resolutions; choosing 'create' produces package 'basic_user1', assigns it to user1, and leaves other 'basic' accounts unchanged.",
    "source": "https://docs.cpanel.net/whm/account-functions/modify-an-account/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "edit-account",
    "upstreamApi": "modifyacct",
    "absorbed": []
  },
  {
    "id": "change-site-ip",
    "behaviors": [
      "Select the account from a list or search by domain/username",
      "Pick the new address from server IPs already added to the pool",
      "Updates web vhosts and DNS A records to the new address (e.g. to give an SSL site its own IP)",
      "Root-level only; resellers need root-level access granted explicitly"
    ],
    "acceptance": "Setting user u1 to 203.0.113.5 rewrites u1's vhost bindings and every A record that pointed at the old IP; an address not in the pool returns IP_NOT_FOUND; a reseller without 'all' gets FORBIDDEN.",
    "source": "https://docs.cpanel.net/whm/account-functions/change-site-ip-address/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "setsiteip",
    "absorbed": []
  },
  {
    "id": "password-modification",
    "behaviors": [
      "Select the account; enter and confirm the new password",
      "No length cap for manual passwords; generated passwords are up to 18 characters",
      "Optional sync of the database (MySQL) password",
      "Optional Digest Authentication toggle for WebDAV clients",
      "Existing passwords are never displayed or recoverable"
    ],
    "acceptance": "Changing u1's password with db_pass_update=1 lets u1 log in to the user panel and to MySQL with the new value; a password scoring below the configured minimum returns WEAK_PASSWORD.",
    "source": "https://docs.cpanel.net/whm/account-functions/password-modification/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "passwd",
    "upstreamApi": "passwd",
    "absorbed": []
  },
  {
    "id": "quota-modification",
    "behaviors": [
      "Rows show domain, user, current usage and quota",
      "Per-row MB value or 'Unlimited', then Save",
      "Search by username or domain; view as all / users / domains; restrict to one reseller's accounts",
      "Hint to rebuild quota files when all quotas read 0",
      "Database storage is not counted against the filesystem quota"
    ],
    "acceptance": "Setting quota=500 for u1 enforces a 500 MB filesystem quota so writes beyond it fail with QUOTA_EXCEEDED; quota=unlimited (or 0) removes the cap.",
    "source": "https://docs.cpanel.net/whm/account-functions/quota-modification/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "quota",
    "upstreamApi": "editquota",
    "absorbed": []
  },
  {
    "id": "limit-bandwidth-usage",
    "behaviors": [
      "Select the account; shows IP, owner, mail addresses, start date, theme, package and disk usage",
      "Enter new limit in MB; 0 or 'unlimited' means no cap",
      "Limits are evaluated by a daily job in the early-morning window, so changes may apply later",
      "Bandwidth limiting is distinct from administrative suspension"
    ],
    "acceptance": "With bwlimit=1024 for u1, once monthly transfer exceeds 1024 MB the daily check flags u1 as bandwidth-exceeded: its sites serve the bandwidth-exceeded page while user-panel login still works.",
    "source": "https://docs.cpanel.net/whm/account-functions/limit-bandwidth-usage/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "limit-bandwidth",
    "upstreamApi": "limitbw",
    "absorbed": []
  },
  {
    "id": "reset-account-bandwidth-limit",
    "behaviors": [
      "Lists only accounts whose bandwidth limit differs from their package default",
      "Columns: domain, user, current limit, package limit; sortable",
      "Per-row 'reset to package limit' (no free-form value here)"
    ],
    "acceptance": "An account on a 500 MB package with a custom unlimited limit appears in the list; after reset its limit is 500 MB and it disappears from the list.",
    "source": "https://docs.cpanel.net/whm/account-functions/reset-account-bandwidth-limit/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "limitbw",
    "absorbed": []
  },
  {
    "id": "unsuspend-bandwidth-exceeders",
    "behaviors": [
      "Single 'proceed' action affecting all bandwidth-blocked accounts",
      "Relief lasts only until the next scheduled bandwidth evaluation",
      "While blocked, websites are unreachable but owners can still log in to the user panel"
    ],
    "acceptance": "After 'proceed', every account flagged bandwidth-exceeded serves its sites again; the next daily check re-flags those still over limit.",
    "source": "https://docs.cpanel.net/whm/account-functions/unsuspend-bandwidth-exceeders/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "upgrade-downgrade-account",
    "behaviors": [
      "Select the account, then choose a package from those the caller may assign",
      "Preview any package's configuration before applying",
      "Applying copies the package limits, feature list, shell/CGI and theme onto the account",
      "Does not change the account's IP address (use Change Site's IP)"
    ],
    "acceptance": "Moving u1 from 'basic' to 'pro' makes every u1 limit equal to 'pro' and leaves its IP unchanged; a reseller picking a package not allowed for it returns FORBIDDEN_PACKAGE, and one whose per-package number is reached returns LIMIT_EXCEEDED.",
    "source": "https://docs.cpanel.net/whm/account-functions/upgrade-downgrade-an-account/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "upgrade-account",
    "upstreamApi": "changepackage",
    "absorbed": []
  },
  {
    "id": "manage-account-suspension",
    "behaviors": [
      "Account list with suspended accounts visually highlighted",
      "Suspend: reason text (strongly encouraged), 'prevent resellers from unsuspending' lock, optional keep-FTP-enabled (API)",
      "Unsuspend: optional 'retain service proxying'",
      "Effects: web traffic redirected to the suspended template, logins blocked by invalidating the stored password hash, password changes refused while suspended, inbound mail handled per server policy; suspending a team owner also suspends its team users",
      "Locked suspensions can be lifted only by root-level users"
    ],
    "acceptance": "After suspending u1 with reason 'Nonpayment', HTTP requests to u1's domains return the suspended template, user-panel login fails, and a password change returns ACCOUNT_SUSPENDED; after unsuspend the original password works again.",
    "source": "https://docs.cpanel.net/whm/account-functions/manage-account-suspension/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "suspend-acct",
    "upstreamApi": "suspendacct, unsuspendacct",
    "absorbed": []
  },
  {
    "id": "terminate-accounts",
    "behaviors": [
      "Account table with search, sortable columns and a 'show only suspended' filter",
      "Per-row Remove with a 'keep DNS zone' checkbox (useful when the account moved within the same DNS cluster)",
      "Multi-select 'remove selected accounts'",
      "Explicit confirmation step before deletion",
      "Deletes home, databases, mail and team users; irreversible; existing backups are not deleted automatically"
    ],
    "acceptance": "Terminating u1 with keepdns=1 removes the system user, home dir and databases while u1's zone still resolves; a delete request without the confirmation token returns CONFIRMATION_REQUIRED; u1's backups remain on disk.",
    "source": "https://docs.cpanel.net/whm/account-functions/terminate-accounts/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "kill-acct",
    "upstreamApi": "removeacct",
    "absorbed": []
  },
  {
    "id": "force-password-change",
    "behaviors": [
      "List of users each with a 'forced' checkbox; select-all and clear-all buttons",
      "On next login the user can only reach the password-change screen until a new password is saved",
      "Flag stays set until the user actually changes the password",
      "API accepts a JSON map of users and a stop-on-failure option"
    ],
    "acceptance": "After forcing u1, every user-panel route except password change returns PASSWORD_CHANGE_REQUIRED for u1's session; after a successful change the flag clears and routes work.",
    "source": "https://docs.cpanel.net/whm/account-functions/force-password-change/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "passwd",
    "upstreamApi": "forcepasswordchange",
    "absorbed": []
  },
  {
    "id": "rearrange-account",
    "behaviors": [
      "Select by domain or by username, then 'Rearrange'",
      "Choose a destination among configured home roots (default home location and additional home directories)",
      "Move the account; its home path changes",
      "Warn that scripts with hard-coded old paths will break"
    ],
    "acceptance": "Moving u1 from /home to /home2 leaves u1's files at /home2/u1 with identical checksums, vhost docroots updated and the old directory gone; a destination outside configured home roots is rejected with INVALID_HOME_ROOT.",
    "source": "https://docs.cpanel.net/whm/account-functions/rearrange-an-account/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "rearrange-accts",
    "upstreamApi": "get_homedir_roots",
    "absorbed": []
  },
  {
    "id": "raw-apache-log-download",
    "behaviors": [
      "Pick a domain and request the download",
      "System compresses the log and returns a download link",
      "File is a plain-text access log listing every visitor request"
    ],
    "acceptance": "Requesting the log for example.test returns a gzip whose decompressed lines equal that vhost's current access log; a reseller requesting a domain it does not own gets FORBIDDEN.",
    "source": "https://docs.cpanel.net/whm/account-functions/raw-apache-log-download/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "raw-ftp-log-download",
    "behaviors": [
      "Pick a domain and request the download",
      "Log lists FTP connections plus uploaded and downloaded files",
      "Compressed plain-text file via a download link",
      "Requires the FTP service to be enabled"
    ],
    "acceptance": "With the FTP service disabled the endpoint returns SERVICE_DISABLED; otherwise it returns a gzip containing only sessions for the chosen domain.",
    "source": "https://docs.cpanel.net/whm/account-functions/raw-ftp-log-download/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "raw-nginx-log-download",
    "behaviors": [
      "Pick a domain and request the download",
      "Log compressed as .gz and offered via link",
      "Plain-text access lines for that domain"
    ],
    "acceptance": "When the domain is served by NGINX, the download is a valid gzip of its access log; when NGINX is not in use the endpoint returns SERVICE_DISABLED.",
    "source": "https://docs.cpanel.net/whm/account-functions/raw-nginx-log-download/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "skeleton-directory",
    "behaviors": [
      "Root skeleton has public_html (website files) and public_ftp (FTP-visible files) subfolders",
      "Each reseller has its own skeleton under its home directory used for accounts it creates",
      "Contents copied only at account creation; existing accounts untouched",
      "Typical use: default index page and custom error pages",
      "Upstream removed the UI in a later version but the directories still work; xWHM should offer a small editor/uploader"
    ],
    "acceptance": "A file placed in reseller R's skeleton public_html appears in public_html of the next account R creates and not in accounts created by root or in pre-existing accounts.",
    "source": "https://docs.cpanel.net/whm/account-functions/skeleton-directory/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "email-all-users",
    "behaviors": [
      "Fields: sender name, sender email, subject, message body",
      "Option to include resellers' customers as well",
      "Two-step flow: first submit shows a review, second submit actually sends",
      "After sending, shows the recipient list (user + address) and a success message; activity visible in the mail log"
    ],
    "acceptance": "The first POST returns a preview with recipient count and sends nothing; the confirm POST sends one message per account with a contact email (accounts without one are skipped) and returns the recipient list.",
    "source": "https://docs.cpanel.net/whm/account-functions/email-all-users/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "manage-demo-mode",
    "behaviors": [
      "Select an existing account (by domain or user search) and click modify",
      "Enable or disable demo mode",
      "In demo mode the panel looks fully functional but changes to files/folders and settings are blocked",
      "Applies to user accounts only, not admin/reseller logins"
    ],
    "acceptance": "With demo mode on for u1, any mutating user-panel API call by u1 returns DEMO_MODE_READONLY while read calls succeed; disabling restores normal writes.",
    "source": "https://docs.cpanel.net/whm/account-functions/manage-demo-mode/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "demo-setup",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "manage-shell-access",
    "behaviors": [
      "One row per account with a choice: disabled, jailed (restricted chroot, recommended), normal",
      "Bulk button to set the same mode for all accounts",
      "Changing an account's shell detaches the value from its package (stored as a per-account override)",
      "A disabled shell may still allow SFTP unless the login shell is set to a no-login binary"
    ],
    "acceptance": "Setting u1 to jailed gives u1 an SSH session confined to its virtual root (host /etc/shadow not visible); setting disabled makes SSH login fail; u1's shell value is reported as an override rather than package-inherited.",
    "source": "https://docs.cpanel.net/whm/account-functions/manage-shell-access/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "modifyacct",
    "absorbed": []
  },
  {
    "id": "web-log-retention",
    "behaviors": [
      "Columns: user, primary domain, retention (custom days or server default), action to open the user's raw-access settings",
      "Search by username or domain",
      "Server default comes from a server-wide setting; a per-account value set by the user overrides it"
    ],
    "acceptance": "An account with a custom 7-day retention shows 7 days while others show the server default; the nightly purge deletes that account's logs older than 7 days.",
    "source": "https://docs.cpanel.net/whm/account-functions/web-log-retention/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "list_accounts_retention",
    "absorbed": []
  },
  {
    "id": "web-template-editor",
    "behaviors": [
      "Tabs: default website page, account moved, connection selection/redirect, account suspended",
      "Preview, save, revert to last saved, revert to shipped default, upload a template file",
      "Template variables for protocol, https flag, panel port and redirect/proxy URLs",
      "Default and suspended pages show the public contact info (or the webmaster address)",
      "Templates are scoped: root's apply to root-owned sites; a reseller's apply only to its accounts"
    ],
    "acceptance": "Saving a custom suspended template as reseller R makes R's suspended accounts render it while root-owned suspended accounts keep the root template; 'revert to default' restores the shipped page.",
    "source": "https://docs.cpanel.net/whm/account-functions/web-template-editor/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "aapanel-default-pages",
        "name": "Default Pages",
        "source": "https://www.aapanel.com/docs/Function/php.html",
        "behaviors": [
          "Four editable templates",
          "Changes affect sites created later; existing sites keep their pages"
        ]
      }
    ]
  },
  {
    "id": "account-enhancements",
    "behaviors": [
      "Enhancement definitions identified by an ID supplied by an add-on",
      "Assign/unassign per account from create and modify forms (section hidden when none exist)",
      "Per-reseller limit per enhancement: a number, unlimited, or 0 (not allowed)",
      "Resellers need the 'use root account enhancements' privilege to assign them"
    ],
    "acceptance": "A reseller with limit 2 for enhancement 'x' can assign it to two accounts; the third assignment returns LIMIT_EXCEEDED, and with limit 0 the first assignment is refused.",
    "source": "https://api.docs.cpanel.net/openapi/whm/operation/assign_account_enhancement/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "assign-root-account-enhancements",
    "upstreamApi": "list_account_enhancements, create_account_enhancement, assign_account_enhancement, unassign_account_enhancement, set_enhancement_limit, list_enhancement_limits",
    "absorbed": []
  },
  {
    "id": "change-multiple-sites-ip",
    "behaviors": [
      "Checkbox per domain, then 'change IPs of selected accounts'",
      "Per-domain new-IP dropdown on the next step",
      "Apply all changes in one submission",
      "Warns that DNS caches may briefly send some visitors to the old address"
    ],
    "acceptance": "Submitting three accounts with new IPs updates all three and returns a per-account result list; an invalid IP for one account marks only that row FAILED (IP_NOT_FOUND) while the other two are applied.",
    "source": "https://docs.cpanel.net/whm/multi-account-functions/change-multiple-sites-ip-addresses/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "setsiteip",
    "absorbed": []
  },
  {
    "id": "modify-upgrade-multiple-accounts",
    "behaviors": [
      "Search panel by user, domain, owner/reseller, package, theme or locale",
      "'Select matching' and 'deselect matching' buttons",
      "Bulk-settable: owner/reseller, theme, start date, display language, package",
      "Applying overrides per-account custom values (e.g. a directly set bandwidth limit)",
      "An account whose user chose their own language keeps it"
    ],
    "acceptance": "Bulk-setting ten selected accounts to package 'pro' leaves all ten with 'pro' limits, including any that had a custom bandwidth limit; accounts whose user set a personal language keep that language.",
    "source": "https://docs.cpanel.net/whm/multi-account-functions/modify-upgrade-multiple-accounts/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "edit-account",
    "upstreamApi": "massmodifyacct, changepackage",
    "absorbed": []
  },
  {
    "id": "add-package",
    "behaviors": [
      "Name is permanent after creation and cannot be the reserved word 'extensions'; reseller-created plans are stored with the reseller's username prefix",
      "Resource fields: disk quota, monthly bandwidth, FTP, mailboxes, per-mailbox max quota, mailing lists, SQL databases per engine, subdomains, aliases, addon domains, Passenger apps, hourly outbound mail per domain, failed/deferred percentage, team users",
      "Settings: dedicated IP (fixed forever), shell, CGI, Digest Auth, theme, feature list (with view link), locale",
      "Package extensions section (only when installed); root can restrict extensions to root-owned plans",
      "Reseller privilege gates: unlimited values, unlimited disk/bandwidth, custom email limits, shell, dedicated IP, addon and alias domains"
    ],
    "acceptance": "A reseller lacking allow-unlimited-disk-pkgs creating a plan with quota=unlimited gets FORBIDDEN_UNLIMITED; root creating 'gold' with maxaddon=0 yields accounts whose addon-domain creation is refused with LIMIT_EXCEEDED; creating a plan named 'extensions' returns NAME_RESERVED.",
    "source": "https://docs.cpanel.net/whm/packages/add-a-package/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "add-pkg",
    "upstreamApi": "addpkg",
    "absorbed": [
      {
        "id": "aapanel-subpanel-packages",
        "name": "Resource Packages",
        "source": "https://www.aapanel.com/docs/Function/Account.html",
        "behaviors": [
          "Disk quota, monthly bandwidth, maximum sites and maximum databases, each of which can be unlimited",
          "Starting and maximum PHP worker processes",
          "Add, edit, delete"
        ]
      }
    ]
  },
  {
    "id": "edit-package",
    "behaviors": [
      "Choose plan, edit, then Save Changes or Reset",
      "Name and dedicated-IP option are read-only",
      "All other resources and settings editable; hourly mail limit cannot exceed the server maximum",
      "Extension variables editable but extensions cannot be added/removed here; missing extensions can be stripped",
      "Root-only extensions appear disabled to resellers and are preserved on save",
      "Warn against assigning the 'disabled' feature list"
    ],
    "acceptance": "Raising 'gold' maxpop from 10 to 20 makes every account on 'gold' report maxpop=20 on the next read; a request changing the plan name or IP flag returns IMMUTABLE_FIELD.",
    "source": "https://docs.cpanel.net/whm/packages/edit-a-package/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "edit-pkg",
    "upstreamApi": "editpkg",
    "absorbed": []
  },
  {
    "id": "delete-package",
    "behaviors": [
      "Select plan and delete",
      "Refused while any account is assigned to the plan",
      "Permanent; must be recreated to restore"
    ],
    "acceptance": "Deleting a plan assigned to at least one account returns PACKAGE_IN_USE with the count; deleting an unused plan removes it from listpkgs.",
    "source": "https://docs.cpanel.net/whm/packages/delete-a-package/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "add-pkg",
    "upstreamApi": "killpkg",
    "absorbed": []
  },
  {
    "id": "feature-manager",
    "behaviors": [
      "Create a list by name; edit via checkbox per feature (feature + description); save",
      "Delete a list: plans/accounts using it fall back to 'default'",
      "Built-ins: 'default' (baseline), 'Mail Only' (mail-centric), 'disabled' (global deny list that overrides every other list and is never assigned directly)",
      "Per-account feature overrides available through the API",
      "Third-party add-ons may register extra feature entries"
    ],
    "acceptance": "Checking 'filemanager' in the 'disabled' list hides File Manager for every account regardless of its own list; deleting list 'pro-features' reassigns its plans to 'default'.",
    "source": "https://docs.cpanel.net/whm/packages/feature-manager/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "add-pkg",
    "upstreamApi": "create_featurelist, update_featurelist, delete_featurelist, get_featurelist_data, get_featurelists, get_feature_names, add_override_features_for_user, remove_override_features_for_user",
    "absorbed": []
  },
  {
    "id": "vendor-feature-entries",
    "behaviors": [
      "Feature entries for Sitejet Builder, WP Toolkit/Deluxe/Site Import, Nova and Nova for WordPress, Imunify360, cPanel Market, AccelerateWP/Resource Usage/X-Ray",
      "Appear only when the vendor product or license is present"
    ],
    "acceptance": "xWHM feature catalog contains none of these entries and the feature-list API rejects their keys with UNKNOWN_FEATURE.",
    "source": "https://docs.cpanel.net/whm/packages/feature-manager/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "reseller-center",
    "behaviors": [
      "Grant reseller status to an existing account, with 'make it own its own account'",
      "Revoke reseller status",
      "Links: change ownership of an account (Modify Account), email all resellers, reset resellers",
      "Per-reseller action menu: edit privileges and nameservers, change ownership of multiple accounts, usage and status, IP delegation, shared IP",
      "Log in to the reseller's admin panel or user panel (root-level only)"
    ],
    "acceptance": "Granting reseller to u1 with makeowner=1 sets u1.owner=u1 and gives exactly the initial privilege set; after revoking, u1's admin-panel login returns FORBIDDEN while its user-panel login still works.",
    "source": "https://docs.cpanel.net/whm/resellers/reseller-center/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "setupreseller, unsetupreseller, listresellers",
    "absorbed": []
  },
  {
    "id": "reseller-privileges",
    "behaviors": [
      "Groups: initial, standard (account info, account management, DNS, packages, third-party, troubleshooting, panel management, enhancements), package, global, super, root",
      "Load a saved privilege list into the form",
      "Save as new list, update an existing list, or apply to this reseller only",
      "Warnings on super and root-level privileges (they bypass package/resource limits; 'all' equals root)",
      "Only root or root-level resellers may change another reseller's privileges"
    ],
    "acceptance": "Removing create-acct from reseller R makes R's POST /xwhm/accounts return FORBIDDEN_ACL while GET /xwhm/accounts (list-accts) still works; granting 'all' lets R list accounts it does not own.",
    "source": "https://docs.cpanel.net/whm/resellers/edit-reseller-nameservers-and-privileges/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "setacls, listacls",
    "absorbed": []
  },
  {
    "id": "reseller-acl-lists",
    "behaviors": [
      "Create or overwrite a named list of privileges",
      "List all saved lists with their privileges",
      "Apply a list to one or many resellers"
    ],
    "acceptance": "Applying saved list 'standard' to resellers A and B gives both exactly the privileges in 'standard', removing any they had that the list lacks.",
    "source": "https://docs.cpanel.net/whm/resellers/edit-reseller-nameservers-and-privileges/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "saveacllist, listacls, setacls",
    "absorbed": []
  },
  {
    "id": "reseller-nameservers",
    "behaviors": [
      "Option: inherit root nameservers (recommended when IPs are scarce)",
      "Option: set up to four explicit nameservers",
      "Per-nameserver A and optional AAAA record using IPs already on the server",
      "Nameserver domains must be registered; ns<number> naming recommended",
      "Clearing the list reverts to server defaults"
    ],
    "acceptance": "Setting ns1/ns2.resellerdns.test for R makes zones of accounts R creates afterwards contain NS records for those hosts; calling with no nameservers reverts R to the server defaults.",
    "source": "https://docs.cpanel.net/whm/resellers/edit-reseller-nameservers-and-privileges/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "ns-config",
    "upstreamApi": "setresellernameservers",
    "absorbed": []
  },
  {
    "id": "reseller-account-limits",
    "behaviors": [
      "Toggle + number: maximum total accounts",
      "Toggle: resource limits with total disk (MB) and total bandwidth (MB); neither may be unlimited (use a huge number to effectively limit only one)",
      "Per-resource 'allow overselling': when off, the sum of owned accounts' allocations may not exceed the total",
      "Resource limits only count accounts that are on packages; super privileges let resellers bypass them",
      "Unlimited-disk/unlimited-bandwidth package privileges cannot be granted while resource limits are on"
    ],
    "acceptance": "With disk limit 10000 MB and disk overselling off, R creating an account whose plan quota would raise R's allocated total to 10500 MB gets LIMIT_EXCEEDED; with overselling on the same request succeeds; with account_limit=5 the sixth account is refused.",
    "source": "https://docs.cpanel.net/whm/resellers/edit-reseller-nameservers-and-privileges/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "setresellerlimits, acctcounts",
    "absorbed": []
  },
  {
    "id": "reseller-package-limits",
    "behaviors": [
      "'Specify packages' toggle with a 'creation allowed' checkbox per package",
      "Optional per-package maximum number of accounts (must be a finite number)",
      "An explicit 'no limit' flag disables package restrictions",
      "Unlimited-quota accounts cannot be constrained by these limits"
    ],
    "acceptance": "With 'gold' allowed and number=3, R's fourth account on 'gold' (via create or upgrade) returns LIMIT_EXCEEDED; using a package not marked allowed returns FORBIDDEN_PACKAGE.",
    "source": "https://docs.cpanel.net/whm/resellers/edit-reseller-nameservers-and-privileges/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "setresellerpackagelimit",
    "absorbed": []
  },
  {
    "id": "change-ownership-multiple-accounts",
    "behaviors": [
      "Choose the new owner reseller, then submit",
      "Select the accounts to move",
      "Apply 'change owner of selected accounts'",
      "Owner changes require root-level rights"
    ],
    "acceptance": "Moving u1 and u2 to reseller R makes both appear in R's account list and vanish from the previous owner's, and R's account count from acctcounts increases by 2.",
    "source": "https://docs.cpanel.net/whm/resellers/change-ownership-of-multiple-accounts/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "modifyacct, massmodifyacct",
    "absorbed": []
  },
  {
    "id": "email-all-resellers",
    "behaviors": [
      "Fields: sender name, sender email, subject, body",
      "Recipients are all reseller accounts only",
      "Send action"
    ],
    "acceptance": "Sending delivers to the contact email of every account with reseller status and to no non-reseller account.",
    "source": "https://docs.cpanel.net/whm/resellers/email-all-resellers/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "manage-reseller-ip-delegation",
    "behaviors": [
      "Select reseller",
      "Open delegation (default): any free server IP",
      "Restricted delegation: pick specific IPs; list marks each as delegated or dedicated",
      "An IP may be delegated to several resellers but dedicated to only one account",
      "Success message names the reseller and saved IPs"
    ],
    "acceptance": "With restricted delegation of only 203.0.113.10 to R, R creating a dedicated-IP account receives 203.0.113.10, and requesting any other IP returns IP_NOT_DELEGATED.",
    "source": "https://docs.cpanel.net/whm/resellers/manage-resellers-ip-delegation/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "setresellerips, getresellerips",
    "absorbed": []
  },
  {
    "id": "manage-reseller-shared-ip",
    "behaviors": [
      "Select reseller",
      "Dropdown of server IPs labeled delegated (with reseller), dedicated (with account) or shared (with reseller)",
      "Save; invalid address error message"
    ],
    "acceptance": "Setting R's shared IP to 203.0.113.20 makes accounts R creates afterwards without a dedicated IP bind to 203.0.113.20, while R's existing accounts keep their IP; an address not on the server returns IP_NOT_FOUND.",
    "source": "https://docs.cpanel.net/whm/resellers/manage-resellers-shared-ip/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "setresellermainip",
    "absorbed": []
  },
  {
    "id": "reset-resellers",
    "behaviors": [
      "Pick a saved privilege list and one or more resellers, then apply",
      "Select resellers and reset package permissions to default",
      "Precaution: clear the 'specify packages' option first, otherwise reset resellers can only use their own packages",
      "Packages already assigned to existing accounts are not changed"
    ],
    "acceptance": "Applying list 'basic' to resellers A and B in one call leaves both with identical privileges; resetting A's package permissions clears its per-package limits without changing the package of any existing account.",
    "source": "https://docs.cpanel.net/whm/resellers/reset-resellers/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "setacls, setresellerpackagelimit",
    "absorbed": []
  },
  {
    "id": "show-reseller-accounts",
    "behaviors": [
      "Grouping by owner, root included",
      "Each owned account shows domain and package"
    ],
    "acceptance": "Every account appears exactly once under its owner group, and root-owned accounts appear under 'root'.",
    "source": "https://docs.cpanel.net/whm/resellers/show-reseller-accounts/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "listresellers, acctcounts, listaccts",
    "absorbed": []
  },
  {
    "id": "view-reseller-usage-and-account-status",
    "behaviors": [
      "Select reseller (auto-selected if only one)",
      "Columns: user, domain, plan, suspended, disk used MB, disk limit, bandwidth used MB, monthly bandwidth limit MB",
      "Previous/next month bandwidth navigation",
      "Suspend all owned accounts, optionally the reseller's own too",
      "Unsuspend all owned accounts, optionally the reseller's own too",
      "Terminate all owned accounts, optionally the reseller's own too (irreversible)"
    ],
    "acceptance": "'Suspend all' for R with include-main=false suspends every account owned by R while R itself can still log in; 'terminate all' with include-main=true deletes R and all its accounts.",
    "source": "https://docs.cpanel.net/whm/resellers/view-reseller-usage-and-manage-account-status/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "resellerstats, suspendreseller, unsuspendreseller, terminatereseller",
    "absorbed": []
  },
  {
    "id": "transfer-tool",
    "behaviors": [
      "Remote address (IP or FQDN) and SSH port (default 22; falls back to admin port 2087 when SSH fails)",
      "Login as root, or as another user then escalate with su or sudo (root password for su)",
      "Authentication by password or by a stored SSH key pair with optional passphrase",
      "Explicit 'connect anyway' confirmation when the remote TLS identity cannot be verified",
      "Security choice: restricted restore (default on; skips unsafe parts, no reseller privileges, no alias/addon domains, shells reset to none/jailed) or copy reseller privileges",
      "Advanced: remote server type (auto, same panel, DirectAdmin, Plesk), unencrypted, compressed rsync, low priority on source, reuse recent/incremental backups, custom packaging modules, transfer threads and restore threads (max 100, default from CPU/RAM), session timeout",
      "Scan shows source summary, rescan option and destination free IPs (accounts with dedicated IPs fail if none are free)",
      "Requirements: ports 2087 and SSH open, IPv4 present, no updates running during transfer"
    ],
    "acceptance": "Scanning a source with a wrong password returns AUTH_FAILED and creates no session; correct credentials return a session id plus the remote inventory of accounts and packages; transfer_threads=101 is rejected with VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/whm/transfers/transfer-tool/prepare-a-source-server/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "rearrange-accts",
    "upstreamApi": "remote_basic_credential_check, create_remote_root_transfer_session, analyze_transfer_session_remote, retrieve_transfer_session_remote_analysis",
    "absorbed": [
      {
        "id": "aapanel-one-click-migration",
        "name": "Site Migration to Another Server",
        "source": "https://www.aapanel.com/docs/Function/Plug-ins.html",
        "behaviors": [
          "Connect to the target server",
          "Choose sites and databases",
          "Track progress"
        ]
      },
      {
        "id": "aapanel-cpanel-import",
        "name": "Import from Another Panel",
        "source": "https://www.aapanel.com/docs/Function/Settings.html",
        "behaviors": [
          "Enter SSH credentials for the source server",
          "Choose accounts and confirm the data",
          "Run the migration; WordPress sites can be moved into the site-management tool"
        ]
      }
    ]
  },
  {
    "id": "transfer-tool-selection",
    "behaviors": [
      "Accounts tab: row and select-all checkboxes, search, sortable columns",
      "Target username (defaults to source) with conflict indicator (red when username or domain exists locally, green when free); existing domains cannot be transferred",
      "Dedicated IP checkbox (preselected for accounts that have one; only free local IPs)",
      "Per-account options: home directory, reseller privileges, databases (renamed on name clash), bandwidth data, integration links, live transfer, update DNS zone, linked-node placement",
      "Overwrite mode: none, overwrite (replace matching files), overwrite with delete (mirror; irreversible)",
      "Apply, apply to other selected, reset to defaults",
      "Packages tab: select packages; their feature lists come along; same-name plans/lists overwritten; missing plan or list falls back to default",
      "Service configurations tab: per-item analysis with warnings and blockers; items include AutoSSL options, backup settings, server tweak settings, database server, web server build, mail server, greylisting, brute-force protection lists (appended), WAF settings, UI themes",
      "Copy enqueues everything selected across tabs"
    ],
    "acceptance": "Selecting remote account 'u1' when local user 'u1' exists with overwrite=none marks the item CONFLICT and refuses to enqueue it; changing target username to 'u1b' enqueues it successfully.",
    "source": "https://docs.cpanel.net/whm/transfers/transfer-tool/select-what-to-transfer/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "rearrange-accts",
    "upstreamApi": "enqueue_transfer_item, validate_system_user, available_transfer_modules, transfer_module_schema",
    "absorbed": []
  },
  {
    "id": "live-transfer",
    "behaviors": [
      "On by default between servers of the same panel; destination hostname must resolve",
      "After restore the source repoints the account's A, NS and MX records to the destination (unless DNS update is disabled)",
      "Source proxies web and mail requests to the destination and re-syncs mailboxes",
      "Source account is suspended; unsuspending it stops the proxying",
      "Mail uses accept-and-queue during the switch; some app sessions may need re-login"
    ],
    "acceptance": "After a live transfer of u1 finishes, the source account is suspended with service proxying on, HTTP requests to u1's domain on the source are served by the destination, and the source zone's A records point at the destination IP.",
    "source": "https://docs.cpanel.net/whm/transfers/transfer-tool/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "rearrange-accts",
    "upstreamApi": "enqueue_transfer_item",
    "absorbed": []
  },
  {
    "id": "account-transfer-progress",
    "behaviors": [
      "Separate transfer and restore sections with per-item progress",
      "Pause (resume by restarting the session); reopen later from Review Transfers",
      "Shows the session id for command-line watching",
      "On completion: per-account links to transfer and restore logs with counts of warnings and skipped items",
      "Summary of severe warnings: rejected log files, renamed databases and DB users, skipped grant tables, with rename actions",
      "Per-item status categories: success, altered, failed, dangerous, skipped, warning"
    ],
    "acceptance": "get state always returns one of TRANSFER_PENDING, TRANSFER_INPROGRESS, RESTORE_PENDING, RESTORE_INPROGRESS, PENDING, COMPLETED, FAILED; pausing an in-progress session stops new items and starting it resumes; a DB renamed on clash appears in the summary with old and new names.",
    "source": "https://docs.cpanel.net/whm/transfers/account-transfer/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "rearrange-accts",
    "upstreamApi": "get_transfer_session_state, pause_transfer_session, start_transfer_session, abort_transfer_session, fetch_transfer_session_log",
    "absorbed": []
  },
  {
    "id": "transfer-or-restore-account",
    "behaviors": [
      "Mode 1: restore from an archive already on disk (overwrite-existing option, A-record replacement mode)",
      "Mode 2: upload an archive (overwrite option, A-record mode, dedicated IP)",
      "Mode 3: remote account using its own username/password (host must be IP or FQDN with valid TLD), dedicated IP option",
      "A-record mode: replace every occurrence of the old server IP (default) or only panel-generated records",
      "Linked-node placement: use archive's stored node, local only, or a specific node",
      "Restricted restore on by default",
      "Accepted archive names (cpmove-USER[.tar[.gz]], USER.tar[.gz], dated backup-...USER.tar[.gz]) from allowed directories only",
      "Needs free disk of at least twice the archive size; 2FA settings are not carried over"
    ],
    "acceptance": "Restoring /home/cpmove-u1.tar.gz with overwrite=0 while u1 exists returns ACCOUNT_EXISTS; an archive under /tmp is rejected with PATH_NOT_ALLOWED; remote mode with a wrong account password returns AUTH_FAILED.",
    "source": "https://docs.cpanel.net/whm/transfers/transfer-or-restore-a-cpanel-account/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "rearrange-accts",
    "upstreamApi": "start_local_cpmove_restore, create_remote_user_transfer_session",
    "absorbed": []
  },
  {
    "id": "account-restore-progress",
    "behaviors": [
      "Live progress with Pause; reopen from Review Transfers via View",
      "Completed banner; per-account restore log link with warning/skipped counts",
      "Same status categories and severe-warning summary as the transfer view, with rename actions",
      "Restricted restore skips corrupted or unsafe components (e.g. tampered grant tables, symlink attacks) and reports them",
      "Reminder to verify the restored account is included in backups"
    ],
    "acceptance": "Restoring an archive containing a symlink that points outside the home directory reports that item as 'dangerous' and the symlink does not exist after restore.",
    "source": "https://docs.cpanel.net/whm/transfers/account-restore/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "rearrange-accts",
    "upstreamApi": "get_transfer_session_state, fetch_transfer_session_log",
    "absorbed": []
  },
  {
    "id": "convert-addon-to-account",
    "behaviors": [
      "List of addon domains with owners, search by domain or owner, Convert action",
      "Account settings: username (suggested from domain), optional contact email, optional package, preserve original owner (root-level only)",
      "Website: copy docroot, custom vhost includes and installed SSL certificate (all on by default)",
      "Custom DNS records: move (default) or revert to the zone template",
      "Email: copy mailboxes, autoresponders, webmail data; move forwarders; mailing lists and webmail data always move; same mailbox format",
      "MySQL: copy databases under new prefixed names, or move selected databases and DB users (source loses access)",
      "Sub-accounts: copy FTP and WebDisk accounts",
      "Start conversion opens history: domain, status (done, in progress, failed), start, end, details",
      "Blockers: account has IPv6 assigned, addon still has subdomains; source data stays and must be cleaned manually; recommend ~3x free space"
    ],
    "acceptance": "Converting addon shop.test of u1 into new account 'shop' creates 'shop' with primary domain shop.test and a copy of the docroot files, moves the forwarders (they no longer exist on u1) and removes the addon from u1; an addon that still has subdomains fails with ADDON_HAS_SUBDOMAINS.",
    "source": "https://docs.cpanel.net/whm/transfers/convert-addon-domain-to-account/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "rearrange-accts",
    "upstreamApi": "convert_addon_list_addon_domains, convert_addon_fetch_domain_details, convert_addon_initiate_conversion, convert_addon_get_conversion_status, convert_addon_list_conversions, convert_addon_fetch_conversion_details",
    "absorbed": []
  },
  {
    "id": "review-transfers-and-restores",
    "behaviors": [
      "Two sections: completed sessions and pending/in-progress sessions",
      "Columns: session id, initiator, source host, start and end time in UTC",
      "Actions: review (logs of a finished session), view (live progress), cancel (pending session)",
      "A pending session with no activity for two hours is marked failed",
      "Session logs are purged after 30 days by nightly maintenance"
    ],
    "acceptance": "A pending session idle for more than 2 hours is listed as failed; cancelling a pending session stops its queued items and moves it to completed with state FAILED/aborted; sessions older than 30 days no longer appear after the nightly purge.",
    "source": "https://docs.cpanel.net/whm/transfers/review-transfers-and-restores/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "rearrange-accts",
    "upstreamApi": "get_transfer_session_state, fetch_transfer_session_log, abort_transfer_session",
    "absorbed": []
  },
  {
    "id": "only-transfer-ip-address",
    "behaviors": [
      "Change server IP via an IP migration wizard",
      "Update the license IP through the vendor store or partner portal"
    ],
    "acceptance": "Not implemented in xWHM; server re-IP (if built) must not depend on any external license call.",
    "source": "https://docs.cpanel.net/whm/transfers/transfer-tool/only-transfer-ip-address/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "basic-server-setup",
    "behaviors": [
      "Contact section: comma-separated alert emails (also used as the SOA responsible mailbox), sender display name, reply-to, SMS/pager emails, push-service tokens, HTTP POST webhook URLs (receive hostname, subject and body as form fields; HTTPS targets must have a valid cert), chat webhook URLs",
      "Exactly one shared IPv4 and at most one shared IPv6; the IPv6 may not fall inside any managed IPv6 range; changing either never rewrites existing accounts (migration tools do that)",
      "Network interface for new IP aliases; primary home root (default /home) plus an extra mount-name match; new accounts land on the root with the most free space",
      "Defaults: webmail theme, auto cgi-bin alias (yes), A-record TTL 14400 (0..2147483647), NS-record TTL 86400, access-log style combined or common",
      "Nameservers 1-4 with a lookup helper that resolves and sets their A/AAAA glue; account creation is blocked until nameservers are set"
    ],
    "acceptance": "Saving TTL=-1 or a shared IPv6 inside an existing IPv6 range returns VALIDATION_ERROR, and createAccount returns NAMESERVERS_NOT_CONFIGURED while ns1/ns2 are empty.",
    "source": "https://docs.cpanel.net/whm/server-configuration/basic-webhost-manager-setup/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "basic-whm-functions",
    "upstreamApi": "update_contact_email",
    "absorbed": []
  },
  {
    "id": "initial-setup-wizard",
    "behaviors": [
      "Shown automatically on the first root login; a persisted completion flag suppresses it afterwards (and an admin can re-arm it)",
      "Each step reuses the validators of the underlying tools (hostname rules, at least two resolvers, nameserver FQDN format, shared IP must be bound)",
      "Optional steps can be skipped; contact email, hostname and nameservers are mandatory",
      "Final step shows a summary of applied changes and links to each tool for later edits"
    ],
    "acceptance": "On a fresh install every root admin route except the wizard and logout redirects to the wizard until it is completed; afterwards POST /wizard/complete returns ALREADY_COMPLETED.",
    "source": "https://docs.cpanel.net/installation-guide/customize-your-installation/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "change-root-password",
    "behaviors": [
      "New password + confirmation fields with a generator",
      "Live strength meter 0-100; minimum comes from the password-strength policy for system accounts",
      "Changes only root; other accounts use their own password tools",
      "Visible only to root or full-privilege resellers"
    ],
    "acceptance": "A password scoring below the configured minimum returns WEAK_PASSWORD, a mismatched confirmation returns VALIDATION_ERROR, and after success SSH password login (if enabled) works with the new value only.",
    "source": "https://docs.cpanel.net/whm/server-configuration/change-root-password/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "aapanel-ssh-root-credentials",
        "name": "Root Password and Key",
        "source": "https://www.aapanel.com/docs/Function/Security.html",
        "behaviors": [
          "Reset root password with a strength check",
          "View and download the root key; generate one if none exists"
        ]
      },
      {
        "id": "aapanel-panel-credentials",
        "name": "Panel Username and Password",
        "source": "https://www.aapanel.com/docs/Function/Settings.html",
        "behaviors": [
          "Change username",
          "Change password under the password policy",
          "CLI recovery for both"
        ]
      }
    ]
  },
  {
    "id": "system-maintenance-schedule",
    "behaviors": [
      "Five cron fields per job: minute, hour, day-of-month, month, weekday (0=Sunday..6); '*' means every value",
      "Defaults: updater at a random time between 21:00 and 06:00, backup at 02:00, legacy backup at 01:00",
      "Backup jobs exit immediately when their backup system is disabled",
      "UI warns when a job would run more than once per day"
    ],
    "acceptance": "Saving minute=60 or weekday=7 returns VALIDATION_ERROR; saving '0 2 * * *' for the backup job writes exactly that schedule into the root crontab entry for the backup runner.",
    "source": "https://docs.cpanel.net/whm/server-configuration/configure-cpanel-cron-jobs/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "disk-quota-setup",
    "behaviors": [
      "Proceed button runs the scan; home mounts marked noauto or loop are skipped",
      "Notifies when a reboot is required and when quotas become functional",
      "Repair action re-initialises quotas (needed after kernel changes or XFS quota re-enable)",
      "Without quotas, disk-usage display and plan disk limits are disabled server-wide; quotas never limit database writes"
    ],
    "acceptance": "On a filesystem without active quota support the scan returns REBOOT_REQUIRED and the dashboard shows quota status 'pending'; once active, a user's reported usage equals the kernel quota value within 1 MB.",
    "source": "https://docs.cpanel.net/whm/server-configuration/initial-quota-setup/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "quota_enabled",
    "absorbed": [
      {
        "id": "aapanel-subpanel-storage",
        "name": "Account Storage Disks",
        "source": "https://www.aapanel.com/docs/Function/Account.html",
        "behaviors": [
          "Show mount point, device, total and used space",
          "Enable quotas on XFS or EXT4",
          "Set the default disk for new accounts"
        ]
      }
    ]
  },
  {
    "id": "virtuozzo-quotas",
    "behaviors": [
      "Requires container-level and per-user/group quota levels on the host",
      "Done on the hypervisor node, not inside the panel"
    ],
    "acceptance": "Not implemented in the panel; the quota setup tool shows a help link when it detects a Virtuozzo container without second-level quotas.",
    "source": "https://docs.cpanel.net/whm/server-configuration/enable-quotas-on-a-virtuozzo-vps/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "linked-server-nodes",
    "behaviors": [
      "Available only on a parent running the full (standard) role; child must run the same major version and the mail or standard role",
      "Link form: child hostname (one link per hostname), friendly name, child root credential exchanged for an API token that expires after 24 h by default",
      "List shows friendly name, hostname, TLS verification status, Manage and Unlink actions; Manage lists accounts distributed to that node",
      "Unlink archives accounts back and needs free disk space; emergency force-dedistribute pulls roles back with an explicit data-loss warning"
    ],
    "acceptance": "Linking a hostname that is already linked returns CONFLICT, linking a child on a different major version returns VERSION_MISMATCH, and force-dedistribute requires confirm=true.",
    "source": "https://docs.cpanel.net/whm/server-configuration/link-server-nodes/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "link_server_node_with_api_token, list_linked_server_nodes, update_linked_server_node, unlink_server_node, force_dedistribution_from_node",
    "absorbed": []
  },
  {
    "id": "server-role-profile",
    "behaviors": [
      "Profiles define enabled, disabled and optional roles (DNS, local/send/receive/relay mail, webmail, calendars/contacts, web server, FTP, file storage, web disk, MySQL, PostgreSQL, spam filter)",
      "Optional roles are selectable only for the DNS, mail and database profiles; PostgreSQL must be installed first",
      "Review step lists every role change; applying with no change is refused",
      "Activation runs in the background with a live log; enabling a role also enables its monitoring; disabled roles hide matching panel features"
    ],
    "acceptance": "Activating the DNS-only profile stops and disables the web and FTP services and removes FTP features from user menus; submitting the current profile unchanged returns NO_CHANGES.",
    "source": "https://docs.cpanel.net/whm/server-configuration/server-profile/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "get_available_profiles, get_current_profile, start_profile_activation, is_role_enabled",
    "absorbed": []
  },
  {
    "id": "web-stats-engines",
    "behaviors": [
      "Status summary, including users whose stats are behind schedule and by how many minutes; process-now for a single user in the background",
      "Per engine: available to users, active by default, allow a per-user include file",
      "User permissions: all users may choose engines, or an allow-list of users with specific engines each",
      "Log and bandwidth processing intervals in 0.25-hour steps (log interval of 24 h or more recommended)",
      "Blackout hours for log analysis (bandwidth still counted) and an option to never overlap with backups"
    ],
    "acceptance": "An interval of 0.3 h returns VALIDATION_ERROR (must be a multiple of 0.25), and a stats job due during a blackout hour starts at the first allowed hour instead.",
    "source": "https://docs.cpanel.net/whm/server-configuration/statistics-software-configuration/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "tweak-stats-programs",
        "name": "Stats Program Toggles",
        "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/stats-programs/",
        "behaviors": [
          "Enable/disable each of the three log analyzers (on)",
          "Reverse DNS of visitor IPs (off)"
        ]
      }
    ]
  },
  {
    "id": "root-web-terminal",
    "behaviors": [
      "One-time risk acknowledgement on first use",
      "Session ends shortly after admin logout; commands already running continue until the session closes; Reconnect opens a fresh session",
      "Resellers need the full-root privilege to see it"
    ],
    "acceptance": "A reseller without the 'all' privilege opening the terminal websocket gets FORBIDDEN, and a root terminal session is closed within 60 s after logout.",
    "source": "https://docs.cpanel.net/whm/server-configuration/terminal-in-whm/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "update-preferences",
    "behaviors": [
      "Release tiers: long-term (one per year), stable, release (default), current, edge (not for production), or a pinned build shown as custom",
      "Automatic major upgrades on the default tier are delayed by a random few business days; forced or manual runs skip the delay",
      "Hourly security-patch job, on by default, applies fixes within the current major version even when version updates are manual",
      "Staging directory picker with automatic fallback when space is insufficient",
      "Push the same preferences to configuration-cluster peers with per-server result"
    ],
    "acceptance": "Setting an unknown tier returns VALIDATION_ERROR, and with security updates on the hourly job installs a newer patch of the same major version but never a new major version.",
    "source": "https://docs.cpanel.net/whm/server-configuration/update-preferences/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "get_available_tiers, set_tier, set_cpanel_updates, update_updateconf, get_update_availability",
    "absorbed": []
  },
  {
    "id": "panel-upgrade",
    "behaviors": [
      "Upgrade button queues the updater job and streams its log",
      "Force option reinstalls even when already current (repairs corrupt files)",
      "Stops and alerts when an upgrade blocker is detected"
    ],
    "acceptance": "Starting an upgrade while one is running returns ALREADY_RUNNING, and force=true on an up-to-date system queues a reinstall job whose log ends with success.",
    "source": "https://docs.cpanel.net/whm/cpanel/upgrade-to-latest-version/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "start_cpanel_update",
    "absorbed": [
      {
        "id": "aapanel-panel-update-repair",
        "name": "Panel Update and Repair",
        "source": "https://www.aapanel.com/docs/Function/Home.html",
        "behaviors": [
          "Switch the update channel and update",
          "Repair the panel files",
          "Restart the panel or reboot the server"
        ]
      }
    ]
  },
  {
    "id": "vendor-marketplace",
    "behaviors": [
      "Commerce integration with the panel vendor"
    ],
    "acceptance": "Not built.",
    "source": "https://docs.cpanel.net/whm/server-configuration/whm-marketplace/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "vendor-usage-analytics",
    "behaviors": [
      "Server and account level opt-in",
      "Configuration analytics always on upstream"
    ],
    "acceptance": "Not built; xPanel sends no telemetry by default.",
    "source": "https://docs.cpanel.net/whm/server-configuration/configure-cpanel-analytics/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "participate_in_analytics",
    "absorbed": []
  },
  {
    "id": "advanced-settings-browser",
    "behaviors": [
      "Category tabs plus an All tab; search filters by setting name and description",
      "Settings persist in one server config store; each change is validated against its type and range",
      "Marker icon on settings that are unset, default-derived or auto-detected",
      "Some settings hide when the server role profile is not full-stack",
      "Single-key get/set API for automation"
    ],
    "acceptance": "GET of an unknown key returns NOT_FOUND, PUT with a value outside the declared range returns VALIDATION_ERROR, and a valid PUT is returned unchanged by the next GET.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "get_tweaksetting, set_tweaksetting",
    "absorbed": []
  },
  {
    "id": "tweak-system",
    "behaviors": [
      "Who may log in to a user's panel (root, owner, user); web server HTTP/HTTPS listen ip:port (0.0.0.0:80 / 0.0.0.0:443)",
      "DNS reload deferral (2 s, max 300), web reload deferral (0 s), minimum gap between graceful web restarts (10 s, 10-600)",
      "Service monitor interval 300 s (60-7200), overlap allowance 2 (1-20), TCP failure threshold 3, HTML and recovery notices on",
      "Panel daemon: max handlers 200 (200-16384), max process memory 4096 MB, max HTTP upload size (1-10240 MB or unlimited), required free quota after upload 5 MB, listen on IPv6 (off)",
      "I/O priority (0-7) for bandwidth (6), stats (7), nightly backups (6), user backups (7), user actions (6), quota checks (6); default jailed shell (off); file-manager trash auto-empty days; do-not-touch-firewall toggles; reseller limit enforcement"
    ],
    "acceptance": "Setting the monitor interval to 30 returns VALIDATION_ERROR (60-7200) and setting it to 600 makes consecutive service checks 600 s apart.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/system/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_tweaksetting",
    "absorbed": []
  },
  {
    "id": "tweak-security",
    "behaviors": [
      "Session cookie IP validation: disabled, loose or strict (default strict); browser autocomplete on login forms (on)",
      "Force HTTPS for panel, webmail, admin and DAV ports (on); blank-referrer and strict-referrer anti-CSRF checks (off)",
      "Verify peer TLS cert during account transfers (on); core dumps (off); never email new-account passwords (off by default)",
      "Default key type for new keys (RSA-2048); self-signed fallback for new domains (on); signature check on mirror downloads; deprecated hash auth (off)",
      "Anti-framing and no-sniff headers on panel ports (on); strict outbound SSH host key checking (disabled|enabled|dns); reboot prompt after critical updates; CSP on selected pages (off)"
    ],
    "acceptance": "With cookie IP validation 'strict', replaying a valid session cookie from a different client IP returns 401 SESSION_IP_MISMATCH.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/security/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_tweaksetting",
    "absorbed": [
      {
        "id": "aapanel-session-security",
        "name": "Session Timeout and Binding",
        "source": "https://www.aapanel.com/docs/faq/Panel_Related.html",
        "behaviors": [
          "Idle timeout in hours",
          "Optional IP plus User-Agent binding",
          "CLI toggle"
        ]
      }
    ]
  },
  {
    "id": "tweak-panel-php",
    "behaviors": [
      "Max execution time 90 s (90-500)",
      "Memory limit 128 MB (128-16384)",
      "Max POST size 55 MB (55-2047); max upload size 50 MB (50-2047)",
      "Optional bytecode loaders for bundled encoded apps"
    ],
    "acceptance": "Setting memory limit to 64 returns VALIDATION_ERROR, and no customer php.ini changes after any save on this tab.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/php/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_tweaksetting",
    "absorbed": []
  },
  {
    "id": "tweak-domains",
    "behaviors": [
      "Off by default: subdomains of the hostname, cross-account subdomains (user or admin), remote domains, unregistered domains, reseller accounts on hostname subdomains",
      "On by default: auto A records for nameservers, replace mismatched service certs, block common/protected domains, zone syntax and owner checks",
      "New accounts get DKIM, SPF and DMARC (on)",
      "Service subdomains (cpanel/webmail/whm/webdisk) and mail client autodiscover/autoconfig (IMAP preferred) on; overwrite of conflicting custom records off",
      "Document roots restricted to public_html (on); share docroot preselected (on); always use registered nameservers for new zones (off)"
    ],
    "acceptance": "With docroot restriction on, creating a subdomain whose document root is outside public_html returns DOCROOT_OUTSIDE_PUBLIC_HTML.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/domains/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_tweaksetting",
    "absorbed": []
  },
  {
    "id": "tweak-mail",
    "behaviors": [
      "Max hourly remote emails per domain (unlimited), daily count that triggers a notice, queue up to 125% of the hourly cap for retry",
      "Unique-recipients-per-hour monitor (on, alert at 500) with action: none, hold or reject; failed/deferred percentage plus count (5) that pauses a domain",
      "Restrict outbound SMTP to the MTA/list manager/root (on); block the 'nobody' user from sending (on); POP-before-SMTP (off); origin tracking headers (on); retry interval 15 min",
      "New mailbox format maildir or mdbox; catch-all default: system account, fail or blackhole; default mailbox quota 32768 MB, user-defined preselected",
      "Feature toggles: challenge-response spam trap, email archiving, mailing lists, webmail client, spam scoring, spam box"
    ],
    "acceptance": "With max hourly emails per domain = 100, the 101st remote message from that domain within one hour is deferred and logged with reason LIMIT_EXCEEDED.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/mail/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_tweaksetting",
    "absorbed": [
      {
        "id": "aapanel-mail-settings",
        "name": "Mail Server Settings",
        "source": "https://www.aapanel.com/docs/Function/MailServer.html",
        "behaviors": [
          "Webmail setup and mail retention period",
          "Blacklist and service-down alerts",
          "Auto-start and status for the MTA, IMAP and spam filter, and editing their configuration"
        ]
      }
    ]
  },
  {
    "id": "tweak-redirection",
    "behaviors": [
      "Closest-match HTTPS redirect (on): tries the origin name, then a matching wildcard cert, then plain https on the domain",
      "When off: separate non-SSL target (hostname or origin) and SSL target (cert name, hostname or origin)",
      "Logout redirect: none or custom URL"
    ],
    "acceptance": "With closest-match on, GET http://example.com/whm returns a redirect to the HTTPS admin port on the best-matching certificate name.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/redirection/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_tweaksetting",
    "absorbed": []
  },
  {
    "id": "tweak-stats-logs",
    "behaviors": [
      "Delete domain access logs after stats (on); archive logs to user home each run (on); purge last month's archives monthly (on)",
      "Extra CPUs added to the load threshold (0); keep FTP master log (off); domain log file mode 0640; stats log level 1-10 (1)",
      "Panel log rotation size threshold 300 MB (min 10)",
      "Retention: mail stats 10 days (1-365000), WAF hits 7 days (0=forever), updater logs 45 days (3-999), web server logs forever unless 3-999 set"
    ],
    "acceptance": "A rotation threshold of 5 returns VALIDATION_ERROR, and a panel log exceeding the threshold is compressed and truncated on the next rotation pass.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/stats-and-logs/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_tweaksetting",
    "absorbed": []
  },
  {
    "id": "tweak-sql",
    "behaviors": [
      "Count databases in disk usage (on), using the schema catalog (on) or filesystem scan",
      "Auto-tune open_files_limit and max_allowed_packet (on); auto-size InnoDB buffer pool by RAM (off)",
      "Require username_ prefix on new databases and DB users (on); force 8-character prefix (off)"
    ],
    "acceptance": "With prefix enforcement on, user alice creating database 'shop' returns VALIDATION_ERROR while 'alice_shop' succeeds.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/sql/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_tweaksetting",
    "absorbed": []
  },
  {
    "id": "tweak-compression",
    "behaviors": [
      "Compression level 1-9 (6)",
      "Parallel compressor processes 1-128 (default CPU core count)",
      "Work-unit size 128-524288 KiB (4096)"
    ],
    "acceptance": "Level 10 returns VALIDATION_ERROR; level 1 produces a backup archive that is larger than the same backup at level 9.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/compression/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_tweaksetting",
    "absorbed": []
  },
  {
    "id": "tweak-notifications",
    "behaviors": [
      "System disk warnings (on) at 82.55% warn and 92.55% critical",
      "Account quota warn 80%, critical 90%, full 98%, each with an 'also notify owner' flag (off/on/on)",
      "Mailbox usage warnings (off) at 80/90/98%; out-of-memory notices (on); certificate expiry notices (on)",
      "Bandwidth enforcement (on: over-limit accounts get HTTP suspended) and warning emails at selectable levels (80% on by default)"
    ],
    "acceptance": "An account crossing 90% of its quota triggers exactly one critical notice to the user and its owner; staying above 90% does not resend until usage drops below and crosses again.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/notifications/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_tweaksetting",
    "absorbed": []
  },
  {
    "id": "tweak-software",
    "behaviors": [
      "Dormant mode per daemon (DAV, brute-force, panel, DNS admin, spam): unload after up to 10 idle minutes (on)",
      "Nightly panel package check (on) with digest verification (on)",
      "Schema-catalog searches in the DB admin tool (on)"
    ],
    "acceptance": "With dormant mode on for the DAV daemon, its process exits after 10 idle minutes and the next DAV request is served after an automatic restart.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/software/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_tweaksetting",
    "absorbed": []
  },
  {
    "id": "tweak-logging",
    "behaviors": [
      "DNS admin log level 0-9 (0)",
      "Verbose zone-sync output (off, testing only)",
      "Log successful logins (off)",
      "Log user API calls (off)"
    ],
    "acceptance": "With successful-login logging on, each panel login appends one line with user, IP and timestamp to the login log.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/logging/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_tweaksetting",
    "absorbed": []
  },
  {
    "id": "tweak-display",
    "behaviors": [
      "Default login theme",
      "Show inode count in user stats (off)",
      "Accounts per page in the account list (30 or all)",
      "Announcement banner (on); plan-upsell column in account list (off)"
    ],
    "acceptance": "Setting accounts per page to 50 makes the account list API default page size 50.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/display/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_tweaksetting",
    "absorbed": [
      {
        "id": "aapanel-page-customization",
        "name": "Panel Page Customization",
        "source": "https://www.aapanel.com/docs/Function/Settings.html",
        "behaviors": [
          "Background image or color",
          "Icon display options"
        ]
      }
    ]
  },
  {
    "id": "tweak-status",
    "behaviors": [
      "Auto (CPU count) or a fixed number",
      "Used by the service status page and the user dashboard load indicator"
    ],
    "acceptance": "With threshold 4 and a 1-minute load average of 5, the status API reports load state 'critical'.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/status/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_tweaksetting",
    "absorbed": []
  },
  {
    "id": "tweak-packages",
    "behaviors": [
      "Email quota 1024 MB",
      "Disk quota 10240 MB",
      "Bandwidth 1048576 MB",
      "Each value capped at 4294967296 MB"
    ],
    "acceptance": "A reseller without unlimited-disk privilege creating a plan without a disk value gets 10240 MB stored; a value above 4294967296 returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/packages/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_tweaksetting",
    "absorbed": []
  },
  {
    "id": "tweak-development",
    "behaviors": [
      "Hooks debug: off, display, display+log, every stage of every event",
      "UI debug: disables minification/cache-busting and logs debug info"
    ],
    "acceptance": "With UI debug on, served panel JS assets are unminified and carry no cache-busting suffix.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/development/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_tweaksetting",
    "absorbed": []
  },
  {
    "id": "tweak-support",
    "behaviors": [
      "Help links in user interfaces (off)",
      "Send anonymised error reports (off; xPanel sends nowhere unless an endpoint is configured)",
      "Update analysis log retention: off, 90 days (default), forever or custom days"
    ],
    "acceptance": "With retention 90 days, update-analysis files older than 90 days are deleted by the nightly cleanup.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/support/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_tweaksetting",
    "absorbed": []
  },
  {
    "id": "tweak-site-software",
    "behaviors": [
      "Controls the legacy script catalog"
    ],
    "acceptance": "Not built.",
    "source": "https://docs.cpanel.net/whm/server-configuration/tweak-settings/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "web-server-status",
    "behaviors": [
      "Header: server version and build, current and last-restart time, restart generation, uptime, total requests and traffic, CPU load, requests/s, bytes/s, KB/request, busy and idle workers",
      "Scoreboard row per worker: slot, PID, access counts, mode (waiting, reading, sending, keep-alive, DNS, closing, cleanup, idle), CPU, seconds since last request, last request ms, KB this connection/child/slot, client IP, vhost, request line",
      "Self-generated wake-up requests from localhost are flagged as internal noise",
      "Requires the status module; disabled when another web server replaces Apache"
    ],
    "acceptance": "With three slow requests in flight, the status API reports busy_workers >= 3 and lists each with client IP, vhost and request line.",
    "source": "https://docs.cpanel.net/whm/server-status/apache-status/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "status",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "daily-process-log",
    "behaviors": [
      "Date selector (yesterday, today)",
      "Usage by user: user, primary domain (accounts only), average %CPU, average %MEM, average DB processes",
      "Top processes: user, domain, peak %CPU, process name",
      "Sampler runs every 5 minutes as root"
    ],
    "acceptance": "After an hour of a CPU-bound process owned by alice, today's report lists alice with average %CPU > 0 and the process in the top-processes table.",
    "source": "https://docs.cpanel.net/whm/server-status/daily-process-log/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "server-information",
    "behaviors": [
      "Processor vendor, model, speed, cache",
      "Memory totals and current usage",
      "Platform, hostname, board/chipset info",
      "Physical disks and current disk usage"
    ],
    "acceptance": "The API returns CPU model, core count, total RAM and per-mount disk usage matching the OS values within 1%.",
    "source": "https://docs.cpanel.net/whm/server-status/server-information/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "stats",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "task-queue-monitor",
    "behaviors": [
      "States: processing, pending, scheduled (fixed future time), deferred (time chosen by module)",
      "Details: command, enqueue time, process ID, remaining retries, child timeout, task ID"
    ],
    "acceptance": "Queuing two long tasks shows one 'processing' and one 'pending', each with task ID, retries and timeout populated.",
    "source": "https://docs.cpanel.net/whm/server-status/task-queue-monitor/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "change-hostname",
    "behaviors": [
      "Must be a lowercase Latin FQDN of at most 60 characters, not starting with 'www' or a digit, not ending with a hyphen",
      "Must not equal an account domain or a service subdomain (cpanel., whm., webmail., ...)",
      "Applies immediately and restarts services that embed the hostname; CalDAV/CardDAV briefly unavailable",
      "Prompts to add an A record for the new name; external auth redirect URIs must be updated"
    ],
    "acceptance": "'www.example.com', '1host.example.com', 'host-' or a 61-character name return INVALID_HOSTNAME; a valid name is returned by the hostname API and used as the MTA primary hostname.",
    "source": "https://docs.cpanel.net/whm/networking-setup/change-hostname/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "sethostname, gethostname",
    "absorbed": []
  },
  {
    "id": "resolver-configuration",
    "behaviors": [
      "Primary and secondary required, tertiary optional; IPv4 or IPv6",
      "Writes the system resolver config",
      "Warns that public open resolvers can break DNS blocklist lookups in the MTA"
    ],
    "acceptance": "Saving one resolver returns VALIDATION_ERROR; saving three valid addresses writes exactly three nameserver lines in the given order.",
    "source": "https://docs.cpanel.net/whm/networking-setup/resolver-configuration/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "setresolvers",
    "absorbed": []
  },
  {
    "id": "userdir-protection",
    "behaviors": [
      "Single toggle plus save",
      "When on, /~user requests are refused; symlink-race protection blocks files not owned by the URL's account",
      "Warns about incompatibilities (non-suPHP handlers, rewrites, per-user module)",
      "Bandwidth for /~user access is not attributed to the right user"
    ],
    "acceptance": "With protection on, GET http://<shared-ip>/~alice/ returns 403 or 404; with it off it serves alice's public_html.",
    "source": "https://docs.cpanel.net/whm/security-center/apache-mod_userdir-tweak/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "compiler-access",
    "behaviors": [
      "Enabled (default): compiler binary mode 0755 root",
      "Disabled: mode 0750 root:compiler; a 'compiler' group is created",
      "Add/remove users to the compiler group",
      "Group membership is not auto-synced with account deletions"
    ],
    "acceptance": "After disabling, a shell user outside the group gets 'Permission denied' running gcc; after adding them, gcc runs.",
    "source": "https://docs.cpanel.net/whm/security-center/compiler-access/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "aapanel-compiler-access",
        "name": "Compiler Access Control",
        "source": "https://www.aapanel.com/docs/Function/Security.html",
        "behaviors": [
          "Select users to deny",
          "Enforced through group ownership and permissions on compiler binaries",
          "Root keeps access"
        ]
      }
    ]
  },
  {
    "id": "security-policies",
    "behaviors": [
      "Limit logins to verified IPs: unknown IPs must answer security questions, then become verified",
      "Two-factor policy switch",
      "Enforce minimum password strength on existing accounts",
      "Maximum password age in days",
      "Extensions: apply policies to admin API calls and to DNS cluster requests"
    ],
    "acceptance": "With max password age 90, a user whose password changed 91 days ago receives PASSWORD_EXPIRED at login and must set a new one.",
    "source": "https://docs.cpanel.net/whm/security-center/configure-security-policies/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "aapanel-password-policy",
        "name": "Password Policy",
        "source": "https://www.aapanel.com/docs/Function/Settings.html",
        "behaviors": [
          "Strong mode: at least 8 characters with upper, lower, digit and symbol",
          "Expiry period; forced change after expiry",
          "Expiry alert task"
        ]
      }
    ]
  },
  {
    "id": "host-access-control",
    "behaviors": [
      "RHEL-family: port-based firewall rules (port, IP/CIDR/wildcard, TCP/UDP, ACCEPT/DROP/REJECT), active immediately",
      "Debian-family: per-daemon rules (daemon, address list, allow/deny, comment) saved as a list",
      "Daemons covered: user panel, admin panel, webmail, web disk, FTP, SSH, SMTP, POP3, IMAP",
      "Allow rules must precede deny rules; 'ALL EXCEPT' syntax; lockout recovery documented"
    ],
    "acceptance": "With ACCEPT 198.51.100.7 then DROP 203.0.113.0/24 on the admin port, a TCP connect from 203.0.113.5 times out while 198.51.100.7 connects.",
    "source": "https://docs.cpanel.net/whm/security-center/host-access-control/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "aapanel-authorized-ip",
        "name": "Authorized IPs",
        "source": "https://www.aapanel.com/docs/Function/Settings.html",
        "behaviors": [
          "Comma-separated list",
          "Empty means anyone",
          "CLI recovery clears the list"
        ]
      }
    ]
  },
  {
    "id": "external-authentication",
    "behaviors": [
      "Configure provider: client ID, client secret, redirect URI, button colours/icon",
      "Per-service enable toggles (user panel, admin panel, webmail); buttons only on HTTPS login pages",
      "Users may link several external identities; local 2FA still applies",
      "Admins list and unlink a user's identities; removing a provider revokes all links; misconfigured providers auto-disable"
    ],
    "acceptance": "Disabling a provider for the admin panel removes its button from the admin login page and its callback returns PROVIDER_DISABLED.",
    "source": "https://docs.cpanel.net/whm/security-center/manage-external-authentications/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "get_available_authentication_providers, set_provider_client_configurations, set_provider_display_configurations, enable_authentication_provider, disable_authentication_provider, get_users_authn_linked_accounts, unlink_user_authn_provider",
    "absorbed": []
  },
  {
    "id": "root-ssh-keys",
    "behaviors": [
      "Generate: key name, optional passphrase with strength score, algorithm and size",
      "Import: paste public/private key; passphrase needed for PuTTY-format keys",
      "New public keys must be authorized before use; deauthorize keeps the files",
      "View key text, delete with confirmation"
    ],
    "acceptance": "A generated key cannot log in until authorized; after deauthorization key login fails while the key still appears in the list.",
    "source": "https://docs.cpanel.net/whm/security-center/manage-root-ssh-keys/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "generatesshkeypair, importsshkey, authorizesshkey, deletesshkey, listsshkeys, convertopensshtoputty",
    "absorbed": []
  },
  {
    "id": "wheel-group-users",
    "behaviors": [
      "Add user to group / remove user from group",
      "Membership grants su to root; sudo needs a separate sudoers rule",
      "Strong warning before adding"
    ],
    "acceptance": "After adding bob, 'su -' as bob with root's password succeeds; after removal it is denied.",
    "source": "https://docs.cpanel.net/whm/security-center/manage-wheel-group-users/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "sudo-group-users",
    "behaviors": [
      "Add/remove users from the sudo group",
      "Shown instead of the wheel tool on Debian-family systems",
      "sudo rights still depend on the sudoers rule"
    ],
    "acceptance": "On a Debian-family host the wheel tool is hidden and adding bob to sudo shows bob in the group listing.",
    "source": "https://docs.cpanel.net/whm/security-center/manage-sudo-group-users/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "waf-settings",
    "behaviors": [
      "Audit logging: relevant only, off, or all (warned: huge and contains private data)",
      "Connection engine and rules engine: on, off, or detection-only",
      "Paths for geolocation and safe-browsing databases; guardian log pipe; HTTP blocklist API key",
      "Backend compression toggle (on); PCRE match limit 1500 and recursion limit 1500"
    ],
    "acceptance": "With the rules engine in detection-only mode, a request matching a blocking rule returns 200 and is recorded as a hit.",
    "source": "https://docs.cpanel.net/whm/security-center/modsecurity-configuration/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "modsec_get_settings, modsec_set_setting, modsec_batch_settings, modsec_deploy_settings_changes, modsec_is_installed",
    "absorbed": []
  },
  {
    "id": "waf-rules",
    "behaviors": [
      "Hits list: most relevant hit per request, link to edit/disable the triggering rule, report a vendor rule false positive",
      "Rules list filterable by vendor; add, edit, copy, edit-all; enable/disable; delete",
      "Changes are staged until 'deploy and restart'; adding with 'deploy now' applies immediately",
      "Vendor rules are read-only here"
    ],
    "acceptance": "A new rule stays 'staged' and does not block traffic until deploy; after deploy a matching request is blocked and appears in hits with that rule ID.",
    "source": "https://docs.cpanel.net/whm/security-center/modsecurity-tools/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "modsec_add_rule, modsec_edit_rule, modsec_clone_rule, modsec_remove_rule, modsec_disable_rule, modsec_undisable_rule, modsec_get_rules, modsec_check_rule, modsec_deploy_rule_changes, modsec_deploy_all_rule_changes, modsec_discard_rule_changes, modsec_get_log, modsec_report_rule",
    "absorbed": []
  },
  {
    "id": "waf-vendors",
    "behaviors": [
      "Add vendor: metadata URL (HTTPS recommended), load preview of name/description/docs/path, save",
      "Enable/disable vendor; auto-update toggle checked during nightly update",
      "Per-config-file enable/disable or all at once",
      "Delete vendor with confirmation; packaged core rule set available"
    ],
    "acceptance": "Disabling one config file of a vendor removes only its rules from the generated WAF config and leaves the vendor's other files active.",
    "source": "https://docs.cpanel.net/whm/security-center/modsecurity-vendors/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "modsec_add_vendor, modsec_preview_vendor, modsec_enable_vendor, modsec_disable_vendor, modsec_enable_vendor_configs, modsec_disable_vendor_configs, modsec_enable_vendor_updates, modsec_disable_vendor_updates, modsec_update_vendor, modsec_remove_vendor, modsec_get_vendors",
    "absorbed": []
  },
  {
    "id": "password-strength",
    "behaviors": [
      "Default required strength (40+ recommended) used by features left on 'default'",
      "Per-feature override (account, email, FTP, database, web disk, subaccounts, etc.)",
      "Values round up to the next multiple of 5",
      "Applies to new passwords; existing ones enforced only via the security policy"
    ],
    "acceptance": "Saving 42 stores 45, and creating an email account with a password scoring 30 when the email minimum is 45 returns WEAK_PASSWORD.",
    "source": "https://docs.cpanel.net/whm/security-center/password-strength-configuration/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "getminimumpasswordstrengths, setminimumpasswordstrengths, get_password_strength",
    "absorbed": []
  },
  {
    "id": "security-advisor",
    "behaviors": [
      "Scan runs on page open; Scan Again button",
      "Severities: critical (red), warning (yellow), info (blue), resolved (green)",
      "Each advisory links to the tool that fixes it",
      "Some OS-level advice may not apply inside containers"
    ],
    "acceptance": "With brute-force protection disabled the scan returns an advisory of severity warning or higher linking to that tool; enabling it and rescanning marks the advisory resolved.",
    "source": "https://docs.cpanel.net/whm/security-center/security-advisor/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "fetch_security_advice",
    "absorbed": [
      {
        "id": "aapanel-security-risk-scan",
        "name": "Security Risk Scanner",
        "source": "https://www.aapanel.com/docs/Function/Home.html",
        "behaviors": [
          "List risks with one-click repair, details and ignore",
          "Detect malicious files in site directories and move them to the recycle bin",
          "Detect web vulnerabilities and run server checks (accounts, SSH daemon, permissions, backdoors, rootkits, history)",
          "Send an alert when a malicious file is found"
        ]
      }
    ]
  },
  {
    "id": "security-questions",
    "behaviors": [
      "Choose or write questions and answers, edit individually",
      "Verified IP list: add (last octet '*' wildcard) and remove",
      "Successful answers from a new IP add it automatically",
      "Affects only the current admin's account"
    ],
    "acceptance": "With the verified-IP policy on, a login from an unlisted IP requires correct answers; after success the IP is listed and the next login skips the questions.",
    "source": "https://docs.cpanel.net/whm/security-center/security-questions/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "fork-bomb-protection",
    "behaviors": [
      "Enable/disable buttons",
      "Limits: core 200000, data 200000, RSS 200000, open files 100, stack 8192, processes 35, virtual memory unlimited",
      "Targets hosting users with a login shell; root unaffected"
    ],
    "acceptance": "With protection on, a shell user's 36th concurrent process fails with 'Resource temporarily unavailable' while root can still spawn processes.",
    "source": "https://docs.cpanel.net/whm/security-center/shell-fork-bomb-protection/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "smtp-restrictions",
    "behaviors": [
      "Enable/disable toggle (mirrors the mail setting of the same purpose)",
      "Implemented as owner-based outbound firewall rules on SMTP ports",
      "Scripts must send through the local MTA where limits and logging apply"
    ],
    "acceptance": "With restrictions on, a process owned by a hosting user connecting to an external host on port 25 is refused or redirected locally, while mail submitted to the local MTA is delivered.",
    "source": "https://docs.cpanel.net/whm/security-center/smtp-restrictions/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "traceroute-toggle",
    "behaviors": [
      "Disabled by default (mode 0700)",
      "Enable sets mode 0755",
      "Out-of-band permission changes are detected and shown"
    ],
    "acceptance": "With traceroute disabled, a hosting user running traceroute gets 'Permission denied'; after enabling it runs.",
    "source": "https://docs.cpanel.net/whm/security-center/traceroute-enable-disable/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "xwhm-two-factor-auth",
    "behaviors": [
      "Policy toggle; issuer name shown in authenticator apps (default hostname)",
      "Own setup: QR code or account+secret, confirm with a 6-digit code (30 s step); reconfigure invalidates old secret; remove",
      "Manage users: list enrolled accounts, disable one, selected or all (not own)",
      "Admins cannot enrol other users; clock skew causes 'invalid code' - NTP sync required",
      "Optional enforcement for admin API calls through the security policy extension"
    ],
    "acceptance": "With 2FA enrolled, a correct password plus wrong code returns TOTP_INVALID, a code from the adjacent 30-second step is accepted, and an admin-disabled user can log in with password only.",
    "source": "https://docs.cpanel.net/whm/security-center/two-factor-authentication-for-whm/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "twofactorauth_enable_policy, twofactorauth_disable_policy, twofactorauth_policy_status, twofactorauth_set_issuer, twofactorauth_get_issuer, twofactorauth_generate_tfa_config, twofactorauth_set_tfa_config, twofactorauth_get_user_configs, twofactorauth_remove_user_config",
    "absorbed": [
      {
        "id": "aapanel-panel-2fa",
        "name": "Panel Two-Factor Authentication",
        "source": "https://www.aapanel.com/docs/Function/Tutorial/Google_Authenticator.html",
        "behaviors": [
          "QR code enrollment",
          "Code required after password",
          "CLI recovery turns it off"
        ]
      }
    ]
  },
  {
    "id": "xwhm-imunify360",
    "behaviors": [
      "Third-party paid plugin"
    ],
    "acceptance": "Not built.",
    "source": "https://docs.cpanel.net/whm/security-center/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "notification-center",
    "behaviors": [
      "Channels: email, HTTP POST URL, push service, chat webhook; each with a threshold (high only, high+medium, all, none) and a Test action",
      "Per-event importance selector with icons showing which channels will receive it",
      "Event categories: accounts, backups, SSL/auto-certs, security, mail, updates/software, system health, DNS cluster, API tokens, misc",
      "Dedup: brute-force alerts at most once per 24 h per user+service+IP; unmonitored-service scan every two weeks",
      "Contact addresses come from Basic Server Setup"
    ],
    "acceptance": "With email set to 'high only', an 'account created' (medium) event is not emailed while 'service down' (high) is, and Test on the POST channel sends hostname, subject and body to every configured URL.",
    "source": "https://docs.cpanel.net/whm/server-contacts/contact-manager/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "get_all_contact_importances, set_application_contact_importance, set_application_contact_event_importance, send_test_posturl, send_test_pushbullet_note, verify_slack_access, verify_posturl_access",
    "absorbed": [
      {
        "id": "aapanel-panel-security-alarm",
        "name": "Panel Security Alerts",
        "source": "https://www.aapanel.com/docs/Function/Settings.html",
        "behaviors": [
          "Toggle",
          "Sent through configured channels"
        ]
      }
    ]
  },
  {
    "id": "system-mail-forwarding",
    "behaviors": [
      "root: admin alerts; nobody: bounces from scripts; panel system user: quota/bandwidth alerts",
      "Destination may be an email address or a hosting username (its default mailbox)",
      "Chaining recommended: nobody and panel user to root, root to an external address"
    ],
    "acceptance": "Setting root's forward to admin@example.net delivers a test message sent to root@<hostname> to admin@example.net.",
    "source": "https://docs.cpanel.net/whm/server-contacts/edit-system-mail-preferences/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "restart-dns",
    "behaviors": [
      "Confirm dialog, then restart with streamed output",
      "Refuses if the service is stopped/disabled (use Service Manager)",
      "Failure output shown with link to logs"
    ],
    "acceptance": "Restarting returns success and a new daemon PID; on a disabled service it returns SERVICE_DISABLED.",
    "source": "https://docs.cpanel.net/whm/restart-services/restart-services/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "restart",
    "upstreamApi": "restartservice",
    "absorbed": []
  },
  {
    "id": "restart-ftp",
    "behaviors": [
      "Confirm then restart",
      "Refuses when FTP is disabled"
    ],
    "acceptance": "With FTP disabled the call returns SERVICE_DISABLED; otherwise port 21 accepts connections after the restart.",
    "source": "https://docs.cpanel.net/whm/restart-services/restart-services/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "restart",
    "upstreamApi": "restartservice",
    "absorbed": []
  },
  {
    "id": "restart-web",
    "behaviors": [
      "Config test before restart; failed test aborts and keeps the running server",
      "Graceful restart when possible"
    ],
    "acceptance": "With a broken include the restart returns CONFIG_TEST_FAILED and sites keep responding.",
    "source": "https://docs.cpanel.net/whm/restart-services/restart-services/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "restart",
    "upstreamApi": "restartservice",
    "absorbed": []
  },
  {
    "id": "restart-imap",
    "behaviors": [
      "Confirm then restart",
      "Existing client sessions are dropped"
    ],
    "acceptance": "After restart, an IMAP LOGIN succeeds within 10 s.",
    "source": "https://docs.cpanel.net/whm/restart-services/restart-services/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "restart",
    "upstreamApi": "restartservice",
    "absorbed": []
  },
  {
    "id": "restart-mta",
    "behaviors": [
      "Config validation before restart",
      "Queue preserved across restart"
    ],
    "acceptance": "Messages queued before the restart are still in the queue afterwards and port 25 answers with a 220 banner.",
    "source": "https://docs.cpanel.net/whm/restart-services/restart-services/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "restart",
    "upstreamApi": "restartservice",
    "absorbed": []
  },
  {
    "id": "restart-mailing-lists",
    "behaviors": [
      "Confirm then restart",
      "Service only runs once at least one list exists"
    ],
    "acceptance": "With no lists defined the call returns SERVICE_NOT_RUNNING; with lists it returns success.",
    "source": "https://docs.cpanel.net/whm/restart-services/restart-services/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "restart",
    "upstreamApi": "restartservice",
    "absorbed": []
  },
  {
    "id": "restart-php-fpm",
    "behaviors": [
      "Confirm then restart every version's FPM master",
      "Reports per-version result"
    ],
    "acceptance": "After restart every enabled FPM pool socket accepts a FastCGI request and the result lists each PHP version with status ok.",
    "source": "https://docs.cpanel.net/whm/restart-services/restart-services/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "restart",
    "upstreamApi": "restartservice",
    "absorbed": []
  },
  {
    "id": "restart-mysql",
    "behaviors": [
      "Confirm then restart",
      "Active connections are dropped"
    ],
    "acceptance": "After restart a root client connection succeeds and server uptime is below 60 s.",
    "source": "https://docs.cpanel.net/whm/restart-services/restart-services/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "restart",
    "upstreamApi": "restartservice",
    "absorbed": []
  },
  {
    "id": "restart-postgresql",
    "behaviors": [
      "Hidden when PostgreSQL is not installed",
      "Confirm then restart"
    ],
    "acceptance": "Without PostgreSQL installed the endpoint returns NOT_INSTALLED.",
    "source": "https://docs.cpanel.net/whm/restart-services/restart-services/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "restart",
    "upstreamApi": "restartservice",
    "absorbed": []
  },
  {
    "id": "restart-ssh",
    "behaviors": [
      "Config test first; invalid config aborts",
      "Existing sessions survive"
    ],
    "acceptance": "With an invalid sshd config the call returns CONFIG_TEST_FAILED and the running daemon keeps accepting logins.",
    "source": "https://docs.cpanel.net/whm/restart-services/restart-services/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "restart",
    "upstreamApi": "restartservice",
    "absorbed": []
  },
  {
    "id": "add-dns-zone",
    "behaviors": [
      "Fields: domain, IPv4, optional owning account (searchable)",
      "Built from the matching zone template",
      "One zone per domain"
    ],
    "acceptance": "Adding a zone for an existing zone's domain returns ZONE_EXISTS; a new zone contains SOA, NS records for configured nameservers and an A record for the given IP.",
    "source": "https://docs.cpanel.net/whm/dns-functions/add-a-dns-zone/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "create-dns",
    "upstreamApi": "adddns",
    "absorbed": []
  },
  {
    "id": "hostname-a-record",
    "behaviors": [
      "Enter IP (defaults to main IP) and add",
      "Adds to the parent zone when present, otherwise creates a zone named after the full hostname"
    ],
    "acceptance": "After adding, querying the local nameserver for the hostname's A record returns the submitted IP.",
    "source": "https://docs.cpanel.net/whm/dns-functions/add-an-a-entry-for-your-hostname/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "addzonerecord",
    "absorbed": []
  },
  {
    "id": "delete-dns-zone",
    "behaviors": [
      "Multi-select list, confirm step",
      "Zones on write-only cluster members are not listed",
      "Reminds that mail routing for the domain may need resetting"
    ],
    "acceptance": "After deletion the local nameserver no longer answers authoritatively for the zone and a second delete returns NOT_FOUND.",
    "source": "https://docs.cpanel.net/whm/dns-functions/delete-a-dns-zone/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "kill-dns",
    "upstreamApi": "killdns",
    "absorbed": []
  },
  {
    "id": "dns-zone-manager",
    "behaviors": [
      "Zone list with name filter and quick-add A/CNAME/MX, DNSSEC and full editor links",
      "Record table (name, TTL, type, data) filter by name/type; add several at once, edit, delete each with confirm",
      "Types: A, AAAA, AFSDB, CAA, CNAME, DMARC(TXT), DNAME, DS, HINFO, HTTPS, LOC, MX, NAPTR, NS, PTR, RP, SOA (edit only), SRV, SVCB, TXT; ALIAS only with the alternate DNS daemon",
      "Reset zone to template (removes custom records); raw zone view",
      "DNSSEC: list keys (tag, ZSK/KSK/CSK, algorithm, created, status), quick or custom create, activate/deactivate, delete, show DS, export, import"
    ],
    "acceptance": "Adding a CNAME where an A record exists returns RECORD_CONFLICT, adding or deleting SOA returns OPERATION_NOT_ALLOWED, and each successful edit increments the SOA serial.",
    "source": "https://docs.cpanel.net/whm/dns-functions/dns-zone-manager/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "edit-dns",
    "upstreamApi": "listzones, parse_dns_zone, addzonerecord, editzonerecord, removezonerecord, mass_edit_dns_zone, resetzone, enable_dnssec_for_domains, disable_dnssec_for_domains, add_zone_key, activate_zone_key, deactivate_zone_key, remove_zone_key, import_zone_key, export_zone_key, fetch_ds_records_for_domains",
    "absorbed": []
  },
  {
    "id": "zone-templates",
    "behaviors": [
      "Templates: simple (A only), standard (dedicated IP, addon, alias), shared-IP standard",
      "Placeholders for domain, owner, IPv4/IPv6, FTP IP, nameservers and their IPs, glue names, mail host, contact email, TTL, NS TTL, serial, panel version",
      "Applies only to zones created after the change; reseller-owned templates take priority"
    ],
    "acceptance": "Adding a TXT line to the shared-IP template makes it appear in the next new account's zone while existing zones stay unchanged; an unknown placeholder returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/whm/dns-functions/edit-zone-templates/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "email-dns-records",
    "behaviors": [
      "Apply default DMARC (v=DMARC1; p=none;) as a background task; domains with DMARC are left untouched",
      "Editable default DMARC record",
      "Validation reports for DKIM, SPF, PTR and DMARC per domain"
    ],
    "acceptance": "The DMARC task adds a _dmarc TXT record to every domain lacking one and leaves existing DMARC records byte-identical.",
    "source": "https://docs.cpanel.net/whm/dns-functions/email-dns-record-manager/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "apply_dmarc, get_default_dmarc_record, set_default_dmarc_record, validate_current_dmarcs, validate_current_dkims, validate_current_spfs, validate_current_ptrs",
    "absorbed": []
  },
  {
    "id": "xwhm-email-routing",
    "behaviors": [
      "Auto detects from local MX data only (no live lookup) and keeps the last value on errors",
      "Local: always accept; backup: accept and hold for higher-priority MX; remote: never accept",
      "MX entries: TTL (14400), priority (default 10 above highest), destination"
    ],
    "acceptance": "Setting a domain to remote makes the local MTA reject RCPT TO for its addresses, and local makes it accept them regardless of MX.",
    "source": "https://docs.cpanel.net/whm/dns-functions/email-routing-configuration/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "edit-mx",
    "upstreamApi": "listmxs, savemxs",
    "absorbed": [
      {
        "id": "aapanel-mail-domains",
        "name": "Mail Domains",
        "source": "https://www.aapanel.com/docs/Function/MailServer.html",
        "behaviors": [
          "Add a domain with A record, server IPs, domain quota, mailbox limit and catch-all",
          "Automatic DNS through a provider API (needs a valid certificate)",
          "Blacklist and spam-reputation check with alerts; refresh records; delete"
        ]
      }
    ]
  },
  {
    "id": "dkim-spf-bulk",
    "behaviors": [
      "Existing SPF gets the server main IP appended; existing DKIM untouched",
      "Runs as a queued background job"
    ],
    "acceptance": "For SPF 'v=spf1 include:x ~all' the result contains the server main IPv4 and still contains include:x; domains without DKIM get a selector TXT record.",
    "source": "https://docs.cpanel.net/whm/dns-functions/enable-dkim-spf-globally/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "enable_dkim, ensure_dkim_keys_exist, install_spf_records",
    "absorbed": []
  },
  {
    "id": "nameserver-report",
    "behaviors": [
      "Columns: nameserver, IPv4/IPv6, zone count, link to zone manager",
      "Refreshed nightly or on demand"
    ],
    "acceptance": "After adding a zone delegated to ns9.example.net and refreshing, the report lists ns9.example.net with zone count incremented by one.",
    "source": "https://docs.cpanel.net/whm/dns-functions/nameserver-record-report/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "lookupnsips",
    "absorbed": []
  },
  {
    "id": "park-domain",
    "behaviors": [
      "Fields: alias domain, target primary domain",
      "Best existing certificate applied, else self-signed, then auto-certificate requested",
      "Refused when the domain's zone has errors or the domain is on the protected list"
    ],
    "acceptance": "Parking a protected domain returns DOMAIN_FORBIDDEN; a successful park serves the target account's document root for the alias host.",
    "source": "https://docs.cpanel.net/whm/dns-functions/park-a-domain/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "park-dns",
    "upstreamApi": "create_parked_domain_for_user",
    "absorbed": []
  },
  {
    "id": "dns-config-cleanup",
    "behaviors": [
      "Proceed button runs cleanup",
      "Reports how many zones were cleaned"
    ],
    "acceptance": "With a duplicated zone stanza injected into the daemon config, cleanup removes it, reports 1 cleaned zone and the daemon reloads without errors.",
    "source": "https://docs.cpanel.net/whm/dns-functions/perform-a-dns-cleanup/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "zone-ttl-bulk",
    "behaviors": [
      "Multi-select zones, positive integer TTL (default 14400)",
      "Changes all records including SOA and NS",
      "Option not to sync the change across the DNS cluster"
    ],
    "acceptance": "TTL 300 on two zones sets every record (including SOA and NS) in both to 300, and TTL 0 or 1.5 returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/whm/dns-functions/set-zone-time-to-live/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "edit-dns",
    "upstreamApi": "mass_edit_dns_zone",
    "absorbed": []
  },
  {
    "id": "domain-forwarding",
    "behaviors": [
      "Map: domain to redirect URL; save map",
      "Forwarder IP is the next free pool address; admin must point the domain's A record at it",
      "Remove forwarder action"
    ],
    "acceptance": "A request to the forwarder IP with Host example.org returns 301 to the mapped URL, and creating a forward with no free pool IP returns NO_FREE_IP.",
    "source": "https://docs.cpanel.net/whm/dns-functions/setup-edit-domain-forwarding/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "dns-cluster-sync",
    "behaviors": [
      "Modes: one zone to this server, all zones to this server, one zone to all servers, all zones to all servers",
      "Optional: include zones not configured locally"
    ],
    "acceptance": "In 'one zone to all servers' mode every cluster peer returns the same SOA serial for that zone afterwards.",
    "source": "https://docs.cpanel.net/whm/dns-functions/synchronize-dns-records/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "clustering",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "db-access-hosts",
    "behaviors": [
      "Lowercase FQDNs or IPs, one per line",
      "Push action adds them to every account's remote-access list",
      "Users can hide but not permanently remove admin-added hosts"
    ],
    "acceptance": "'DB.Example.com' returns VALIDATION_ERROR (lowercase required); after pushing 203.0.113.10, every MySQL user has a grant for that host.",
    "source": "https://docs.cpanel.net/whm/sql-services/additional-mysql-access-hosts/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "postgresql-setup",
    "behaviors": [
      "Install config (warns it overwrites the host-based auth file)",
      "Create roles for accounts created before PostgreSQL was installed",
      "Change superuser password with strength meter",
      "Visible only when PostgreSQL is installed"
    ],
    "acceptance": "After 'create users', every hosting account has a PostgreSQL role with the same name.",
    "source": "https://docs.cpanel.net/whm/sql-services/configure-postgresql/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "db-ownership-map",
    "behaviors": [
      "Select account and engine, enter comma-separated databases and users",
      "Only objects not owned by any account",
      "Cannot move objects between accounts"
    ],
    "acceptance": "Mapping a database owned by another account returns ALREADY_OWNED; mapping an unowned one makes it appear in the target user's database list.",
    "source": "https://docs.cpanel.net/whm/sql-services/database-map-tool/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "aapanel-db-sync",
        "name": "Sync Database Inventory",
        "source": "https://www.aapanel.com/docs/Function/MySQL.html",
        "behaviors": [
          "Sync all from the panel to the server",
          "Get databases from the server into the panel (passwords are not imported)"
        ]
      }
    ]
  },
  {
    "id": "db-users-admin",
    "behaviors": [
      "Table: user, database, owning account; sort and search",
      "Rename with optional new password",
      "Length limits including prefix: MySQL 5.7+ 32, MariaDB 47, legacy MySQL 16"
    ],
    "acceptance": "Renaming to a 33-character name on MySQL 8 returns VALIDATION_ERROR; a valid rename keeps all grants under the new name.",
    "source": "https://docs.cpanel.net/whm/sql-services/manage-database-users/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "list_database_users, rename_mysql_user, rename_postgresql_user",
    "absorbed": [
      {
        "id": "aapanel-db-batch-password",
        "name": "Bulk Database Password Change",
        "source": "https://www.aapanel.com/docs/Function/MySQL.html",
        "behaviors": [
          "Select several databases",
          "Set new passwords for them"
        ]
      },
      {
        "id": "db-user-password",
        "name": "Change Database User Password",
        "source": "https://docs.cpanel.net/whm/sql-services/change-mysql-user-password/",
        "behaviors": [
          "Select user, new + confirm, generator, strength meter",
          "Minimum strength from the password policy"
        ]
      }
    ]
  },
  {
    "id": "databases-admin",
    "behaviors": [
      "Table: database, engine, owner; sort and search",
      "Rename keeps prefix rule; max 64 chars (63 with prefix), underscore counts double",
      "Rename = create new, copy data, recreate grants and routines, drop old; active connections are killed"
    ],
    "acceptance": "Renaming alice_shop to shop2 with prefixing on returns VALIDATION_ERROR; renaming to alice_shop2 preserves tables, row counts and user grants.",
    "source": "https://docs.cpanel.net/whm/sql-services/manage-databases/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "list_databases, rename_mysql_database, rename_postgresql_database",
    "absorbed": []
  },
  {
    "id": "db-server-profiles",
    "behaviors": [
      "Fields: immutable name, host, port 1-65535, user, password, description; or bootstrap a superuser over SSH (password or stored key)",
      "Validate, activate (exactly one active), edit, delete (not the active one)",
      "Switching profiles never migrates existing data",
      "Remote server must hold its own root credentials file; one panel server per remote DB server"
    ],
    "acceptance": "Deleting the active profile returns IN_USE, and activating a profile that fails validation returns PROFILE_INVALID while the previous profile stays active.",
    "source": "https://docs.cpanel.net/whm/sql-services/manage-mysql-profiles/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "remote_mysql_create_profile, remote_mysql_create_profile_via_ssh, remote_mysql_read_profiles, remote_mysql_update_profile, remote_mysql_delete_profile, remote_mysql_validate_profile, remote_mysql_initiate_profile_activation, remote_mysql_monitor_profile_activation",
    "absorbed": [
      {
        "id": "aapanel-remote-db-servers",
        "name": "Remote Database Servers",
        "source": "https://www.aapanel.com/docs/Function/MySQL.html",
        "behaviors": [
          "Add a server with host, port and an admin account",
          "Pick it as the target when creating a database"
        ]
      }
    ]
  },
  {
    "id": "db-root-password",
    "behaviors": [
      "New + confirm, generator, strength meter",
      "Target local or remote (remote preselected when a remote profile is active)",
      "Warns about characters that break the web DB admin tool"
    ],
    "acceptance": "After change, the root credentials file holds the new password and a client login with it succeeds while the old one fails.",
    "source": "https://docs.cpanel.net/whm/sql-services/mysql-root-password/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_local_mysql_root_password",
    "absorbed": [
      {
        "id": "aapanel-db-root-password",
        "name": "Database Root Password",
        "source": "https://www.aapanel.com/docs/Function/MySQL.html",
        "behaviors": [
          "View the password",
          "Set a new one"
        ]
      }
    ]
  },
  {
    "id": "db-engine-upgrade",
    "behaviors": [
      "Choose target from installable versions (MySQL 8.0, MariaDB LTS releases)",
      "Config pre-check warnings that must each be acknowledged; optional upgrade-checker run",
      "Unattended or interactive mode; streamed progress with autoscroll; final success/fix-needed message",
      "No downgrades; MySQL to MariaDB is one-way; log files kept per run"
    ],
    "acceptance": "A target older than current returns DOWNGRADE_NOT_SUPPORTED, and starting without acknowledging every warning returns WARNINGS_NOT_ACKNOWLEDGED.",
    "source": "https://docs.cpanel.net/whm/sql-services/mysql-or-mariadb-upgrade/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "installable_mysql_versions, current_mysql_version, background_mysql_upgrade_checker_run, start_background_mysql_upgrade, background_mysql_upgrade_status",
    "absorbed": []
  },
  {
    "id": "db-repair",
    "behaviors": [
      "Select database, run repair, per-table result",
      "Skips InnoDB tables of the webmail database"
    ],
    "acceptance": "A MyISAM table marked crashed is reported 'repaired' and becomes readable afterwards.",
    "source": "https://docs.cpanel.net/whm/sql-services/repair-a-mysql-database/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "db-process-list",
    "behaviors": [
      "Columns: id, user, host:port, database, command, time, state, statement",
      "Read-only listing (xPanel may add a kill action guarded by confirmation)"
    ],
    "acceptance": "An idle connection opened by alice appears with user alice, command Sleep and an increasing time value.",
    "source": "https://docs.cpanel.net/whm/sql-services/show-mysql-processes/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "add-ip",
    "behaviors": [
      "Formats: a.b.c.d/24-30, a.b.c.d/netmask, a.b.c.d-e; plus subnet mask and exclusions",
      "Behind 1:1 NAT enter the private address",
      "Added as aliases on the main interface and activated at boot",
      "Pool rebuilt after adding"
    ],
    "acceptance": "Adding 192.0.2.128/25 with exclusion 192.0.2.130 adds 127 addresses to the pool, and a /23 returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/whm/ip-functions/add-a-new-ip-address/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "addips",
    "absorbed": [
      {
        "id": "aapanel-ip-setup",
        "name": "Server IP Setup",
        "source": "https://www.aapanel.com/docs/Function/Plug-ins.html",
        "behaviors": [
          "Add or remove IPs on supported distributions",
          "Recommend taking a snapshot before changes"
        ]
      }
    ]
  },
  {
    "id": "assign-ipv6",
    "behaviors": [
      "Pick account and range (only ranges with free addresses) or shared IPv6",
      "Enable binds address and adds AAAA for all account domains; disable unbinds and removes",
      "Re-enable later gets a different address; not for accounts distributed to mail nodes"
    ],
    "acceptance": "Enabling IPv6 for an account binds one address and adds AAAA records for all its domains; disabling removes both.",
    "source": "https://docs.cpanel.net/whm/ip-functions/assign-ipv6-address/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "ipv6_enable_account, ipv6_disable_account, listipv6s",
    "absorbed": []
  },
  {
    "id": "remote-service-ips",
    "behaviors": [
      "Remote mail server IPs: one per line, treated as local for routing detection",
      "Remote nameserver IPs: one per line, allow parked/addon domains delegated to them",
      "Cluster nameservers must be added manually"
    ],
    "acceptance": "After listing a remote nameserver's IP, adding an addon domain delegated to it no longer returns REMOTE_DOMAIN_NOT_ALLOWED.",
    "source": "https://docs.cpanel.net/whm/ip-functions/configure-remote-service-ips/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "ip-migration-wizard",
    "behaviors": [
      "Enter new IPs (CIDR allowed); old-to-new mapping in order with editable leftovers; download mapping",
      "Rewrite web, FTP and panel data; vhosts temporarily listen on old and new",
      "Rewrite DNS zones, then wait about 48 h",
      "Final steps: remove old IPs, update network scripts, licence IP, shared IP, reseller main IPs, hostname A record, custom configs"
    ],
    "acceptance": "Mapping IP A to B rewrites every vhost, FTP and zone reference from A to B, and vhosts answer on both until the removal step runs.",
    "source": "https://docs.cpanel.net/whm/ip-functions/ip-migration-wizard/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "setsiteip",
    "absorbed": []
  },
  {
    "id": "ipv6-ranges",
    "behaviors": [
      "Fields: name (<=64), CIDR range, type available/reserved, notes (<=256)",
      "Must not contain the shared IPv6; reserve the gateway as /128 first",
      "Delete blocked while any address is assigned; requires panel IPv6 listening"
    ],
    "acceptance": "Deleting a range with an assigned address returns IN_USE, and a range containing the shared IPv6 returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/whm/ip-functions/ipv6-address-ranges/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "ipv6_range_add, ipv6_range_edit, ipv6_range_list, ipv6_range_remove, ipv6_range_usage",
    "absorbed": []
  },
  {
    "id": "rebuild-ip-pool",
    "behaviors": [
      "Scan bound IPs not linked to any domain",
      "Report the number of free IPs"
    ],
    "acceptance": "After deleting the only account on a dedicated IP, a rebuild reports that IP as free and the next new dedicated-IP account can get it.",
    "source": "https://docs.cpanel.net/whm/ip-functions/rebuild-the-ip-address-pool/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "ip-usage-report",
    "behaviors": [
      "Columns: IP, HTTP domains, FTP domains, mail domains with account counts"
    ],
    "acceptance": "A domain with three mailboxes on IP X appears under X as 'domain (3 accts)'.",
    "source": "https://docs.cpanel.net/whm/ip-functions/show-ip-address-usage/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "ip-addresses-list",
    "behaviors": [
      "Columns: interface, IP, notes (main/shared/dedicated with up to 10 users and a count)",
      "Delete only unused addresses",
      "NAT view: local IP, public IP or 'not routable', warnings; validate via external echo; edit mapping (public IP unique)"
    ],
    "acceptance": "Deleting an IP used as any account's or the shared IP returns IN_USE, and mapping two local IPs to one public IP returns CONFLICT.",
    "source": "https://docs.cpanel.net/whm/ip-functions/show-or-delete-current-ip-addresses/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "listips, delip, get_shared_ip, nat_checkip, nat_set_public_ip, get_public_ip",
    "absorbed": []
  },
  {
    "id": "reserved-ips",
    "behaviors": [
      "Checkbox per IP, save",
      "Reserved IPs excluded from new account assignment",
      "Web server stops listening on them after config rebuild"
    ],
    "acceptance": "With 192.0.2.140 reserved, creating 20 dedicated-IP accounts never assigns it and the web server does not answer on it.",
    "source": "https://docs.cpanel.net/whm/ip-functions/show-edit-reserved-ips/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "web-reserved-ips",
        "name": "Web Server Reserved IPs",
        "source": "https://docs.cpanel.net/whm/service-configuration/reserved-ip-address-editor/",
        "behaviors": [
          "Checkbox per bound IP; save",
          "Reserved IPs get no listeners and no new accounts",
          "Rebuild and restart now or later"
        ]
      }
    ]
  },
  {
    "id": "web-stack-builder",
    "behaviors": [
      "Home: currently installed packages (view, customize, save as profile) and available profiles; upload profile JSON from file or URL",
      "Customize wizard: MPM (exactly one), modules, PHP versions, PHP extensions (filter by version), app-server packages, additional packages (e.g. reverse proxy), review, provision",
      "Adding a PHP version offers to copy extensions installed for other versions, version only, or a custom pick",
      "Conflicts shown with resolve prompts; review lists install/upgrade/remove/unchanged",
      "Provisioning one profile at a time; packages not in the profile are removed"
    ],
    "acceptance": "A profile selecting two MPMs returns CONFLICT, and provisioning a profile lists then removes installed stack packages absent from it.",
    "source": "https://docs.cpanel.net/whm/software/easyapache-4-interface/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "ea4_list_profiles, ea4_save_profile, ea4_get_currently_installed_packages, ea4_metainfo, ea4_recommendations, package_manager_resolve_actions, package_manager_submit_actions",
    "absorbed": [
      {
        "id": "aapanel-web-server",
        "name": "Web Server Selection",
        "source": "https://www.aapanel.com/docs/Function/php.html",
        "behaviors": [
          "One active web server",
          "Rewrite rules may need redoing after a switch"
        ]
      }
    ]
  },
  {
    "id": "module-installers",
    "behaviors": [
      "Links to each installer",
      "Modules are usable from custom scripts"
    ],
    "acceptance": "The hub lists only installers whose runtime is present on the server.",
    "source": "https://docs.cpanel.net/whm/software/module-installers/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "xwhm-perl-modules",
    "behaviors": [
      "Search by keyword or list all; install by exact name",
      "Installed table with update, reinstall, uninstall, docs"
    ],
    "acceptance": "Installing a module makes 'perl -MModule -e1' exit 0, and uninstalling makes it fail.",
    "source": "https://docs.cpanel.net/whm/software/install-a-perl-module/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "pear-packages",
    "behaviors": [
      "Select PHP version (shows include path)",
      "Search or list all; install, update, reinstall, uninstall, docs"
    ],
    "acceptance": "A package installed for PHP 8.1 resolves under that version's include path and is absent from 8.2's.",
    "source": "https://docs.cpanel.net/whm/software/php-extensions-and-applications-package/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "pecl-extensions",
    "behaviors": [
      "Select PHP version; search stable modules or list all; install by name",
      "Installed list with version, update, reinstall, uninstall, docs; installed extensions enabled by default",
      "Warns that disabling exec breaks the installer on newer PHP"
    ],
    "acceptance": "Installing an extension for PHP 8.1 shows it in 8.1's loaded modules and not in 8.2's.",
    "source": "https://docs.cpanel.net/whm/software/php-pecl/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "ruby-gems",
    "behaviors": [
      "Search, install, update, reinstall, uninstall gems"
    ],
    "acceptance": "Not built.",
    "source": "https://docs.cpanel.net/whm/software/ruby-gem-installer/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "distro-packages",
    "behaviors": [
      "Search by partial name, install with live progress",
      "No third-party repositories"
    ],
    "acceptance": "Installing a package found by partial name ends with it reported installed by the OS package manager; a name not in configured repos returns NOT_FOUND.",
    "source": "https://docs.cpanel.net/whm/software/install-distro-packages/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "package_manager_list_packages, package_manager_submit_actions, package_manager_is_performing_actions",
    "absorbed": []
  },
  {
    "id": "php-ini-editor",
    "behaviors": [
      "Basic mode: common directives with type-aware inputs (see notes for defaults)",
      "Editor mode: full file; reserved words (null, yes, no, true, false, on, off, none) and certain symbols rejected as directive names",
      "Saves to the version's own php.ini; reset by restoring the packaged default",
      "Format checks only; does not guarantee PHP runs"
    ],
    "acceptance": "Setting memory_limit=256M for PHP 8.2 makes ini_get('memory_limit') return 256M on that version after reload, and a directive named 'true' returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/whm/software/multiphp-ini-editor/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "php_ini_get_directives, php_ini_set_directives, php_ini_get_content, php_ini_set_content",
    "absorbed": []
  },
  {
    "id": "php-manager-system",
    "behaviors": [
      "System default version (deprecated versions need explicit confirmation); affects inheriting domains only",
      "Handler per installed version (CGI, FPM, LSAPI, embedded, suEXEC-style variants per notes)",
      "FPM on/off default for new accounts; convert-all-domains with memory pre-check and log",
      "System FPM pool and INI defaults (shared with the PHP-FPM service tool)"
    ],
    "acceptance": "Changing the system default changes the effective version of inheriting domains and leaves domains with an explicit version unchanged; convert-all on insufficient RAM returns INSUFFICIENT_MEMORY.",
    "source": "https://docs.cpanel.net/whm/software/multiphp-manager-for-whm-system-settings/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "php_get_installed_versions, php_get_system_default_version, php_set_system_default_version, php_get_handlers, php_set_handler, php_get_default_accounts_to_fpm, php_set_default_accounts_to_fpm, convert_all_domains_to_fpm, is_conversion_in_progress",
    "absorbed": [
      {
        "id": "aapanel-php-manager",
        "name": "PHP Version Manager",
        "source": "https://www.aapanel.com/docs/Function/Deployment.html",
        "behaviors": [
          "Install or remove extensions",
          "Upload size and timeout limits, common settings, the raw ini file and the FPM pool file",
          "Re-enable functions that are disabled by default, and choose the session store (files, an in-memory store or memcache)",
          "Runtime log, slow log and the PHP info page"
        ]
      },
      {
        "id": "aapanel-php-cli",
        "name": "Command-Line PHP Version",
        "source": "https://www.aapanel.com/docs/Function/php.html",
        "behaviors": [
          "Pick a version",
          "Re-check after installing a new version"
        ]
      }
    ]
  },
  {
    "id": "php-manager-domains",
    "behaviors": [
      "Table: domain, account, version (or inherited), FPM status; expandable rows",
      "Change version (dependent inheriting domains follow); set inherit (FPM becomes unavailable)",
      "FPM toggle per domain unless inheriting or unsupported version",
      "Bulk: set version, set inherit, disable FPM",
      "Per-domain pool values and INI overrides each with a lock that makes them non-overridable"
    ],
    "acceptance": "Enabling FPM on an inheriting domain returns FPM_UNAVAILABLE_FOR_INHERIT, and Max Children 0 or 10001 returns VALIDATION_ERROR (1-10000).",
    "source": "https://docs.cpanel.net/whm/software/multiphp-manager-for-whm-user-domain-settings/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "php_get_vhost_versions, php_set_vhost_versions, php_get_vhosts_by_version, php_get_impacted_domains, php_fpm_config_get, php_fpm_config_set",
    "absorbed": []
  },
  {
    "id": "nginx-proxy-manager",
    "behaviors": [
      "Landing page installs when absent; uninstall action",
      "System tab: cache-by-default toggle, clear cache for all, restart, rebuild configuration, reset all users to system default",
      "Users tab: search by account/owner, per-user cache toggle and clear, bulk enable/disable/clear",
      "Optional user-facing toggle controlled by a feature-list entry",
      "Offers switching from standalone mode to reverse-proxy mode"
    ],
    "acceptance": "Disabling cache for alice clears her cache directory and her responses stop showing a HIT cache status, while bob's remain cached.",
    "source": "https://docs.cpanel.net/whm/software/nginx-manager/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "nginxmanager_get_cache_config_system, nginxmanager_get_cache_config_users, nginxmanager_set_cache_config, nginxmanager_reset_users_cache_config, nginxmanager_clear_cache, nginxmanager_rebuild_cache_config",
    "absorbed": [
      {
        "id": "aapanel-nginx-manager",
        "name": "Web Server Manager (Nginx family)",
        "source": "https://www.aapanel.com/docs/Function/Deployment.html",
        "behaviors": [
          "Start, stop and reload; edit the main configuration, which is validated before reload",
          "Switch between compatible distributions",
          "Performance tuning, load view, access-log format, error log"
        ]
      },
      {
        "id": "aapanel-website-speed",
        "name": "Website Acceleration Cache",
        "source": "https://www.aapanel.com/docs/Function/Plug-ins.html",
        "behaviors": [
          "Turn acceleration on per site",
          "Exclusion rules per site and a global configuration",
          "Operation log"
        ]
      }
    ]
  },
  {
    "id": "package-db-rebuild",
    "behaviors": [
      "Proceed button runs rebuild",
      "Hidden on Debian-family systems"
    ],
    "acceptance": "On a Debian-family host the endpoint returns NOT_SUPPORTED; on RHEL-family a rebuild ends with a package query succeeding.",
    "source": "https://docs.cpanel.net/whm/software/rebuild-rpm-database/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "package_manager_fixcache",
    "absorbed": []
  },
  {
    "id": "os-update",
    "behaviors": [
      "Include kernel packages checkbox",
      "Shows reboot-required state after kernel updates",
      "Single-package updates via API"
    ],
    "acceptance": "Running with kernel excluded leaves the installed kernel version unchanged; with it included and a newer kernel available, system_needs_reboot becomes true.",
    "source": "https://docs.cpanel.net/whm/software/system-update/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "package_manager_upgrade, package_manager_submit_actions, system_needs_reboot",
    "absorbed": []
  },
  {
    "id": "server-software-update",
    "behaviors": [
      "Proceed button starts the update with output",
      "Kernel and panel upgrades handled elsewhere"
    ],
    "acceptance": "The run never changes the kernel or panel version and ends with a list of updated dependency packages.",
    "source": "https://docs.cpanel.net/whm/software/update-server-software/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "xwhm-wp-toolkit",
    "behaviors": [
      "Third-party plugin"
    ],
    "acceptance": "Not built.",
    "source": "https://docs.cpanel.net/whm/software/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "xwhm-softaculous",
    "behaviors": [
      "Third-party plugin"
    ],
    "acceptance": "Not built.",
    "source": "https://docs.cpanel.net/whm/software/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "xwhm-installatron",
    "behaviors": [
      "Third-party plugin"
    ],
    "acceptance": "Not built.",
    "source": "https://docs.cpanel.net/whm/software/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "apache-global-config",
    "behaviors": [
      "TLS: cipher suite, protocol list (default excludes SSLv2/3, TLS1.0/1.1), OCSP stapling (on)",
      "Logging/headers: extended status (on), log level (warn), combined and common log formats, TRACE (off), server signature (off), server tokens, ETag (none), root directory options",
      "Process model: StartServers 5, MinSpareServers 5, MaxSpareServers 10 (prefork only), ServerLimit 256, MaxRequestWorkers 150 (<= ServerLimit), MaxConnectionsPerChild 10000 (0 = never)",
      "Connections: KeepAlive (off), KeepAliveTimeout 5 s, MaxKeepAliveRequests 100 (0 = unlimited), Timeout 300 s; keep-alive values are mirrored to the reverse proxy",
      "Symlink race protection (off); save, then rebuild+restart; reset discards unsaved edits"
    ],
    "acceptance": "Saving MaxRequestWorkers=300 with ServerLimit=256 returns VALIDATION_ERROR; saving KeepAlive=On regenerates the config, passes a config test and gracefully restarts the web server.",
    "source": "https://docs.cpanel.net/whm/service-configuration/global-configuration/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "apache-config-hub",
        "name": "Web Server Configuration Hub",
        "source": "https://docs.cpanel.net/whm/service-configuration/apache-configuration/",
        "behaviors": [
          "Links to each web server sub-tool",
          "Shows pending-rebuild indicator"
        ]
      },
      {
        "id": "aapanel-apache-manager",
        "name": "Web Server Manager (Apache)",
        "source": "https://www.aapanel.com/docs/Function/Deployment.html",
        "behaviors": [
          "Service control and configuration edit with validation",
          "Version switch, tuning, load view, log format, run log"
        ]
      }
    ]
  },
  {
    "id": "directory-index-priority",
    "behaviors": [
      "Add, remove, move up/down",
      "Save then rebuild and restart"
    ],
    "acceptance": "With order [index.php, index.html], a directory containing both serves index.php; after swapping, it serves index.html.",
    "source": "https://docs.cpanel.net/whm/service-configuration/directoryindex-priority/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "web-config-includes",
    "behaviors": [
      "Three insertion points: pre-main, pre-vhost, post-vhost",
      "Scope: a specific web server version (reset on version change) or all versions",
      "Content may reference files or directories to include",
      "Config test before activation (xPanel addition)"
    ],
    "acceptance": "An include with an invalid directive returns CONFIG_TEST_FAILED and the previous include and running server remain unchanged.",
    "source": "https://docs.cpanel.net/whm/service-configuration/include-editor/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "process-memory-limit",
    "behaviors": [
      "Enable checkbox and integer limit (> 1)",
      "Applies per process, not to the whole server",
      "Takes effect after rebuild and restart"
    ],
    "acceptance": "A value of 1 or a non-integer returns VALIDATION_ERROR; a valid value appears as the memory rlimit directive in the generated config.",
    "source": "https://docs.cpanel.net/whm/service-configuration/memory-usage-restrictions/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "web-log-rotation",
    "behaviors": [
      "Logs: error log, access log, WAF debug log, suEXEC audit log",
      "Archived when over the size threshold (300 MB default) or at month end",
      "Archives never auto-deleted"
    ],
    "acceptance": "With the error log selected and grown past the threshold, the next rotation run produces a compressed archive and a fresh error log.",
    "source": "https://docs.cpanel.net/whm/service-configuration/log-rotation/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "piped-logging",
    "behaviors": [
      "Enabled by default; toggle and save",
      "Reduces open log file handles on servers with many domains"
    ],
    "acceptance": "With piped logging on, the web server holds a constant number of log file handles regardless of vhost count and each domain's log still receives its own requests.",
    "source": "https://docs.cpanel.net/whm/service-configuration/piped-log-configuration/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "panel-log-rotation",
    "behaviors": [
      "Checkbox per panel log",
      "Monthly compression into one archive per log type",
      "Never auto-deleted"
    ],
    "acceptance": "At month end each selected log is compressed into the archive directory and restarted empty; unselected logs are untouched.",
    "source": "https://docs.cpanel.net/whm/service-configuration/cpanel-log-rotation-configuration/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webdisk-tls",
    "behaviors": [
      "Cipher list and protocol list text fields",
      "Defaults allow only TLS 1.2+ with modern AEAD/ECDHE ciphers"
    ],
    "acceptance": "A protocol list enabling TLS 1.0 returns VALIDATION_ERROR, and a TLS 1.1 handshake to the WebDAV port fails with defaults.",
    "source": "https://docs.cpanel.net/whm/service-configuration/cpanel-web-disk-configuration/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "panel-web-tls",
    "behaviors": [
      "Cipher list and protocol list fields",
      "Only TLS 1.2 and 1.3 supported; 1.3 needs a recent OpenSSL"
    ],
    "acceptance": "After removing a cipher from the list, a client offering only that cipher fails the handshake on the admin port.",
    "source": "https://docs.cpanel.net/whm/service-configuration/cpanel-web-services-configuration/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "mta-basic-editor",
    "behaviors": [
      "ACL tab: dictionary-attack protection, HELO requirements, SMTP delay for suspicious hosts, ratelimits, DKIM verification, recipient soft/hard limits, spam score reject/ratelimit thresholds",
      "Access lists: blocked IPs, sender-verify bypass, trusted relays, backup MX hosts, trusted users, blocked domains and countries",
      "Domains and IPs: send from account IP, rDNS-based HELO, custom per-domain IP and HELO files",
      "Filters and mail: dangerous attachment filter, spam subject prefix, sender verification, smarthost with auth, SRS, ARC, suspended-account delivery policy, max line length",
      "RBLs (custom lists, exemptions), TLS (require TLS before AUTH, cipher list), spam scanner options (size threshold, outgoing scan, rule sets)"
    ],
    "acceptance": "With 'require TLS before AUTH' on, AUTH on a plaintext SMTP session returns a 5xx refusal, and every save runs a syntax check that returns CONFIG_TEST_FAILED on error without replacing the live config.",
    "source": "https://docs.cpanel.net/whm/service-configuration/exim-configuration-manager-basic-editor/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "validate_exim_configuration_syntax, exim_configuration_check, validate_current_installed_exim_config, save_spamd_config",
    "absorbed": []
  },
  {
    "id": "mta-config-manager",
    "behaviors": [
      "Advanced editor stores overrides in local option/section files merged when the config is regenerated",
      "Backup to download or to the server; restore from upload or stored backup",
      "Reset types: full default, minimum version upgrade, reset ACLs, reset advanced options, disable custom ACLs",
      "Warns that TLS file overrides break mail SNI"
    ],
    "acceptance": "Backup, change, then restore yields a generated MTA config byte-identical to the pre-change one.",
    "source": "https://docs.cpanel.net/whm/service-configuration/exim-configuration-manager/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "remove_in_progress_exim_config_edit, validate_exim_configuration_syntax, rebuild_mail_sni_config",
    "absorbed": []
  },
  {
    "id": "ftp-server-config",
    "behaviors": [
      "TLS mode: disabled, optional, required for commands, required for commands and data; cipher suite",
      "Anonymous logins and uploads toggles; load ceiling for anonymous downloads",
      "Idle timeout, server-wide max connections, max connections per IP",
      "Root password access to all FTP accounts toggle; broken-client compatibility mode",
      "Directory listing cap (10,000 entries default) adjustable"
    ],
    "acceptance": "With max connections per IP = 2, a third simultaneous login from one IP is refused, and with TLS required a plaintext USER command is rejected.",
    "source": "https://docs.cpanel.net/whm/service-configuration/ftp-server-configuration/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "aapanel-ftp-port",
        "name": "FTP Service Port",
        "source": "https://www.aapanel.com/docs/Function/Ftp.html",
        "behaviors": [
          "Set the port",
          "Remind the admin to open it in the firewall and the provider's security group"
        ]
      },
      {
        "id": "aapanel-ftp-service",
        "name": "FTP Server Management",
        "source": "https://www.aapanel.com/docs/Function/Deployment.html",
        "behaviors": [
          "Start, stop and restart",
          "Edit the configuration file",
          "Switch version and manage logs"
        ]
      }
    ]
  },
  {
    "id": "ftp-server-selection",
    "behaviors": [
      "Choices: quota-capable daemon, bandwidth-stats daemon, disabled (default disabled because FTP is cleartext)",
      "Shown only when the FTP role is enabled"
    ],
    "acceptance": "Selecting disabled stops FTP, closes port 21 and hides FTP account features; selecting a daemon starts it and port 21 answers.",
    "source": "https://docs.cpanel.net/whm/service-configuration/ftp-server-selection/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "configureservice",
    "absorbed": []
  },
  {
    "id": "mailbox-server-config",
    "behaviors": [
      "Protocols IMAP/POP3 (LMTP always on), IPv6, plaintext auth from remote, weak schemes, cipher list, minimum TLS 1.2, service subdomains in SNI",
      "Limits: max mail processes 512, process memory 512 MB, IMAP 20 and POP3 3 connections per IP, idle hibernate 30 s, IDLE keepalive 24 min",
      "Auth: spare 2 / max 50 processes, 128 MB, cache 1M, success/failure cache 3600 s, new process per connection (no), config service memory 2048 MB",
      "Trash in quota (off), compression 0-9 (6) when on, auto-expunge trash/spam with day counts, mdbox rotation size 10M and interval",
      "Quota-full response: reject or defer; LMTP min processes 0, limit 500, per-user concurrency 4"
    ],
    "acceptance": "Setting max IMAP connections per IP to 5 makes the 6th concurrent IMAP login from one IP fail, and disabling POP3 closes ports 110 and 995.",
    "source": "https://docs.cpanel.net/whm/service-configuration/mailserver-configuration/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "service-ssl-certificates",
    "behaviors": [
      "Table: service, certificate domains, expiry, key type; details with issuer and self-signed warning",
      "Install: paste cert, key, optional CA bundle, or browse existing; autofill by certificate",
      "Reset to a fresh self-signed certificate",
      "Expired certs replaced with self-signed and a free cert ordered on the next nightly run; expiry warnings by email and dashboard"
    ],
    "acceptance": "Installing a cert with a non-matching key returns KEY_MISMATCH, and after a valid install the IMAPS port presents the new certificate's fingerprint.",
    "source": "https://docs.cpanel.net/whm/service-configuration/manage-service-ssl-certificates/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "fetch_service_ssl_components, install_service_ssl_certificate, reset_service_ssl_certificate, get_best_ssldomain_for_service",
    "absorbed": [
      {
        "id": "aapanel-panel-ssl",
        "name": "Panel SSL",
        "source": "https://www.aapanel.com/docs/Function/Settings.html",
        "behaviors": [
          "Self-signed by default",
          "Paste PEM key and certificate or request ACME for the bound domain",
          "CLI toggle for recovery"
        ]
      }
    ]
  },
  {
    "id": "nameserver-selection",
    "behaviors": [
      "Choices: default authoritative daemon, alternate daemon (not on some OSes), disabled",
      "Switch converts zones and restarts",
      "Recommends disabling when the server's nameservers are not used"
    ],
    "acceptance": "Switching daemon keeps every zone's record set identical when queried before and after, and the previous daemon ends stopped and disabled.",
    "source": "https://docs.cpanel.net/whm/service-configuration/nameserver-selection/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_nameserver",
    "absorbed": [
      {
        "id": "aapanel-builtin-dns-server",
        "name": "Self-Hosted DNS Server",
        "source": "https://www.aapanel.com/docs/Function/Domains.html",
        "behaviors": [
          "Add a domain, which creates default records automatically",
          "Enable DKIM and SPF and apply a DMARC policy",
          "Edit the SOA record; service status and default DNS settings; delete a domain"
        ]
      }
    ]
  },
  {
    "id": "service-manager",
    "behaviors": [
      "Per service: Enabled and Monitor checkboxes (monitor requires enabled); list depends on installed software and role profile",
      "Monitor restarts failed services and sends failure/recovery/timeout alerts",
      "Extra listening port for the MTA alternate-port service",
      "Background log tailers (mail stats, WAF log, mail health, bandwidth) toggled here"
    ],
    "acceptance": "monitor=true on a disabled service returns VALIDATION_ERROR, and with monitoring on, killing the process leads to an automatic restart and a recovery notice within two check intervals.",
    "source": "https://docs.cpanel.net/whm/service-configuration/service-manager/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "configureservice, get_service_config, get_service_config_key, set_service_config_key, enable_monitor_all_enabled_services, configurebackgroundprocesskiller",
    "absorbed": [
      {
        "id": "aapanel-service-control",
        "name": "Installed Services",
        "source": "https://www.aapanel.com/docs/Function/Settings.html",
        "behaviors": [
          "Show status for each service",
          "Start, stop, restart"
        ]
      },
      {
        "id": "service-status",
        "name": "Service Status",
        "source": "https://docs.cpanel.net/whm/server-status/service-status/",
        "behaviors": [
          "Per service: up, down or pending (monitoring paused during restarts/installs)",
          "Load average, memory and swap used; disk per device/mount",
          "Icons: ok under 80%, warning 80-89%, critical 90% or more",
          "Mount points can be excluded via config; disk part requires disk warnings enabled"
        ]
      }
    ]
  },
  {
    "id": "php-fpm-service",
    "behaviors": [
      "Pool defaults: process manager mode, Max Children (5, 1-10000), Max Requests (20, 1-10000000), Process Idle Timeout (10 s, 1-10000000); start/min-spare/max-spare when dynamic",
      "INI defaults with lock: allow_url_fopen, log_errors, short_open_tag, error_log, disable_functions, error_reporting (lock = admin value users cannot override)",
      "Validate, update, reset buttons; regenerates pools of domains without their own overrides",
      "Utilisation: pool count and how often pools hit Max Children",
      "Restart FPM masters for all versions"
    ],
    "acceptance": "Setting system Max Requests to 500 regenerates pm.max_requests = 500 for domains without overrides and leaves overridden domains unchanged; Max Children 0 returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/whm/software/multiphp-manager-for-whm-system-settings/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "php_fpm_config_get, php_fpm_config_set, get_fpm_count_and_utilization",
    "absorbed": []
  },
  {
    "id": "generate-csr",
    "behaviors": [
      "Fields: optional email, domains (one per line, wildcard allowed), key type (RSA-2048 default, RSA-4096, ECDSA P-256, P-384), city, state, country, organisation, division, optional challenge passphrase",
      "Outputs shown and stored in the server SSL store; optional email copy"
    ],
    "acceptance": "Key type ECDSA P-256 yields a prime256v1 key and a CSR whose SAN list equals the submitted domains; an invalid country code returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/whm/ssl-tls/generate-an-ssl-certificate-and-signing-request/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "ssl-gencrt",
    "upstreamApi": "generatessl",
    "absorbed": []
  },
  {
    "id": "install-ssl",
    "behaviors": [
      "Domain field with autofill from stored certs; browse certs filtered by account",
      "Certificate, private key and optional CA bundle",
      "IP selector for domains without a dedicated IP (shared/available only)",
      "Self-signed warning; best-match certificate chosen when several fit"
    ],
    "acceptance": "A cert whose SANs do not cover the domain returns CERT_DOMAIN_MISMATCH, a non-matching key returns KEY_MISMATCH, and after success an SNI request for the domain receives that cert.",
    "source": "https://docs.cpanel.net/whm/ssl-tls/install-an-ssl-certificate-on-a-domain/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "ssl",
    "upstreamApi": "installssl, fetchsslinfo, fetch_ssl_certificates_for_fqdns",
    "absorbed": []
  },
  {
    "id": "auto-ssl",
    "behaviors": [
      "Provider: default free ACME provider or disabled; capability table (DCV methods, ancestor DCV, domains per cert, validity, rate limit, wildcard); terms acceptance",
      "Options: user and admin notification level (all, failures+warnings+deferrals default, failures only, none); replace invalid or <3-day-expiring non-auto certs (off)",
      "Runs nightly, after account creation, on demand for all or one user; CAA pre-check before ordering",
      "Logs kept 30 days (text + JSON); pending queue view",
      "Per-user enable/disable/reset to feature-list default"
    ],
    "acceptance": "A domain whose CAA forbids the provider is skipped with a CAA error and no order placed, and with replacement off a valid paid cert expiring in 10 days is never replaced.",
    "source": "https://docs.cpanel.net/whm/ssl-tls/manage-autossl/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "get_autossl_providers, set_autossl_provider, reset_autossl_provider, disable_autossl, get_autossl_metadata, set_autossl_metadata_key, start_autossl_check_for_all_users, start_autossl_check_for_one_user, get_autossl_logs_catalog, get_autossl_log, get_autossl_problems_for_user, add_autossl_user_excluded_domains",
    "absorbed": []
  },
  {
    "id": "ssl-hosts",
    "behaviors": [
      "Columns: expiry, key type, domains with secure/insecure lock, IP, dedicated/shared, primary on IP, SNI required, docroot, owner, issuer",
      "Delete certificate from vhost",
      "Make primary on shared IP (needs web server running)"
    ],
    "acceptance": "Making site B primary on a shared IP causes a non-SNI HTTPS request to that IP to receive B's certificate.",
    "source": "https://docs.cpanel.net/whm/ssl-tls/manage-ssl-hosts/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "ssl",
    "upstreamApi": "fetch_ssl_vhosts, delete_ssl_vhost, set_primary_servername",
    "absorbed": []
  },
  {
    "id": "ssl-storage",
    "behaviors": [
      "Installed web server SSL resources with site and owner",
      "Keys, CSRs and certs on one row when they share a public key",
      "View parsed details and raw text; delete with confirmation"
    ],
    "acceptance": "Deleting a key used by an installed certificate returns IN_USE, and a key, CSR and cert with the same modulus appear on one row.",
    "source": "https://docs.cpanel.net/whm/ssl-tls/ssl-storage-manager/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "ssl",
    "upstreamApi": "listcrts, rebuildinstalledssldb, rebuilduserssldb",
    "absorbed": [
      {
        "id": "aapanel-ssl-certificate-manager",
        "name": "Certificate Manager",
        "source": "https://www.aapanel.com/docs/Function/Domains.html",
        "behaviors": [
          "Request a single, multi-domain or wildcard certificate for domains in the list",
          "Upload certificate and key in common formats (PEM, CRT, CER, DER, PFX/P12, P7B)",
          "Auto-renew and expiry-warning toggles; renew everything expiring within 30 days in one action",
          "Deploy to sites or other targets"
        ]
      }
    ]
  },
  {
    "id": "default-key-type",
    "behaviors": [
      "Default RSA-2048; same value as the security settings tab",
      "Users may choose their own type",
      "Changing it triggers re-issue of automatic certificates with the new type"
    ],
    "acceptance": "Changing the default to ECDSA P-256 queues an automatic-certificate run after which re-issued auto certs use ECDSA keys and uploaded certs are untouched.",
    "source": "https://docs.cpanel.net/whm/ssl-tls/ssl-tls-configuration/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "set_tweaksetting",
    "absorbed": []
  },
  {
    "id": "purchase-ssl",
    "behaviors": [
      "Store checkout flow"
    ],
    "acceptance": "Not built.",
    "source": "https://docs.cpanel.net/whm/ssl-tls/purchase-and-install-an-ssl-certificate/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "ssl-buy",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "backup-config",
    "behaviors": [
      "Global: enable (off), type compressed/uncompressed/incremental (incremental only to rsync-type targets), minimum free space in % or MB (check on), per-file upload timeout, per-file restore timeout",
      "Schedule: daily on chosen weekdays, weekly on one day, monthly on the 1st and/or 15th; retention 1-9999 each; strict retention option",
      "Contents: accounts (with user selection), suspended accounts, access logs, bandwidth data, local vs cluster DNS, system files",
      "Databases: per-account dumps, whole data directory, or both; PostgreSQL optional",
      "Directories: backup dir /backup, staging dir rules, keep local copies, mount backup drive as needed"
    ],
    "acceptance": "Saving with no schedule or with neither accounts nor system files returns VALIDATION_ERROR, staging dir '/home' or '/etc/x' returns INVALID_PATH, and retention 10000 returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/whm/backup/backup-configuration/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "backup_config_get, backup_config_set",
    "absorbed": [
      {
        "id": "aapanel-mail-backup",
        "name": "Mail Store Backup",
        "source": "https://www.aapanel.com/docs/Function/MailServer.html",
        "behaviors": [
          "Scheduled backup",
          "Import from an upload, a server path or an existing backup"
        ]
      }
    ]
  },
  {
    "id": "backup-destinations",
    "behaviors": [
      "Types: extra local dir, S3, S3-compatible, B2, Google Drive, FTP, SFTP, rsync, WebDAV, custom script",
      "Common: name, also send system backups, logs-only flag, timeout 30-300 s (retry twice then alert)",
      "Type-specific fields (see notes); key or password auth for SFTP/rsync",
      "Save, or save and validate; per-row validate; validation results tab"
    ],
    "acceptance": "Validating an SFTP target with wrong credentials records status failed with an auth message without affecting other targets, and timeout 20 returns VALIDATION_ERROR.",
    "source": "https://docs.cpanel.net/whm/backup/backup-configuration/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "backup_destination_add, backup_destination_set, backup_destination_get, backup_destination_list, backup_destination_delete, backup_destination_validate, backup_generate_google_oauth_uri",
    "absorbed": [
      {
        "id": "aapanel-backup-destinations",
        "name": "Remote Backup Destinations",
        "source": "https://www.aapanel.com/docs/Function/Plug-ins.html",
        "behaviors": [
          "Configure FTP, S3-compatible (including other S3 API vendors), and cloud drive or bucket credentials",
          "Choose the destination for each backup task"
        ]
      }
    ]
  },
  {
    "id": "backup-restoration",
    "behaviors": [
      "By account (pick users then date) or by date (pick date then users)",
      "Options: restore subdomains (on), mail config (on), databases (on), source local/remote, give dedicated IP",
      "Queue statuses: pending, restoring, completed, completed with warnings, failed; clear pending/completed/failed; view logs",
      "One account added at a time; re-queue only after its current run ends"
    ],
    "acceptance": "Queuing an account already restoring returns ALREADY_QUEUED, and restoring a deleted account recreates its domains, mailboxes and databases with the entry ending 'completed'.",
    "source": "https://docs.cpanel.net/whm/backup/backup-restoration/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "backup_date_list, backup_user_list, restore_queue_add_task, restore_queue_activate, restore_queue_list_pending, restore_queue_list_active, restore_queue_list_completed, restore_queue_clear_pending_task, restore_queue_clear_all_failed_tasks",
    "absorbed": []
  },
  {
    "id": "backup-user-selection",
    "behaviors": [
      "Toggle per user (auto-saves)",
      "Enable or disable for all accounts",
      "Legacy column only if legacy backups exist"
    ],
    "acceptance": "With alice toggled off, the next scheduled run creates archives for every included account except alice.",
    "source": "https://docs.cpanel.net/whm/backup/backup-user-selection/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "toggle_user_backup_state, backup_skip_users_all, backup_skip_users_all_status",
    "absorbed": []
  },
  {
    "id": "file-restore",
    "behaviors": [
      "Browse the account home or type a relative path; show backups containing the item",
      "Choose a backup and restore; overwrites existing and recreates deleted files",
      "Local backups only; mail and internal settings directories excluded"
    ],
    "acceptance": "Restoring public_html/index.php from yesterday replaces it with yesterday's content, and restoring the mail directory returns PATH_NOT_RESTORABLE.",
    "source": "https://docs.cpanel.net/whm/backup/file-and-directory-restoration-for-whm/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "file-restore",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "backup-legacy-migration",
    "behaviors": [
      "Shown only when legacy backups exist",
      "Copies settings and renames the legacy config"
    ],
    "acceptance": "Not built; foreign legacy archives are imported through the account transfer/restore path.",
    "source": "https://docs.cpanel.net/whm/backup/backup-system-migration/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "convert_and_migrate_from_legacy_config",
    "absorbed": []
  },
  {
    "id": "xwhm-api-tokens",
    "behaviors": [
      "Name unique, up to 50 chars of letters, digits, dash, underscore",
      "Privileges: at least one, only from the creator's own set; warnings on full-root, password change, session creation and token management",
      "Expiry: none or a date (default one year, ends 23:59:59 server time); IP/CIDR allow list up to 100 entries",
      "Secret shown once at creation; list with name, created, expires, IPs; yellow when expiring, red when expired (not auto-deleted)",
      "Edit, revoke one or all; deleting an account revokes its tokens; suspended accounts cannot create tokens"
    ],
    "acceptance": "Requesting a privilege the creator lacks returns FORBIDDEN, a token limited to 198.51.100.0/24 used from 203.0.113.9 returns 403 TOKEN_IP_DENIED, and a revoked token returns 401.",
    "source": "https://docs.cpanel.net/whm/development/manage-api-tokens-in-whm/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "manage-api-tokens",
    "upstreamApi": "api_token_create, api_token_list, api_token_get_details, api_token_update, api_token_revoke",
    "absorbed": [
      {
        "id": "aapanel-panel-api",
        "name": "Panel API Access",
        "source": "https://www.aapanel.com/docs/api/api-list.html",
        "behaviors": [
          "Toggle and regenerate secret",
          "Caller IP allow list",
          "Each request carries a timestamp and a token derived from timestamp and secret",
          "Same functions as the web UI"
        ]
      }
    ]
  },
  {
    "id": "xwhm-api-shell",
    "behaviors": [
      "Requires the API shell setting; root or full-root resellers only",
      "Pick function, enter parameters, optional filter/sort/paginate/columns",
      "Result as tree, table or raw (headers separated)",
      "Warns that calls act on live data"
    ],
    "acceptance": "With the setting off the shell returns FEATURE_DISABLED; with it on, a list call with page size 10 returns at most 10 rows plus pagination metadata.",
    "source": "https://docs.cpanel.net/whm/development/api-shell-for-whm/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "applist",
    "absorbed": []
  },
  {
    "id": "registered-apps",
    "behaviors": [
      "Tables: admin apps (name, required privileges, system user, URLs, origin, PHP config, display name, entry URL), user and webmail apps (required features instead of privileges)",
      "Origin 'internal' for built-ins, else the registration file name"
    ],
    "acceptance": "Registering an app file makes it appear in the matching table with its required privileges, and removing the file removes it.",
    "source": "https://docs.cpanel.net/whm/development/apps-managed-by-appconfig/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "get_appconfig_application_list",
    "absorbed": []
  },
  {
    "id": "plugin-generator",
    "behaviors": [
      "Per item: unique ID, name, feature-list support, group (or new group), priority 1-99, URI, 48x48 SVG/PNG icon",
      "Plugin name: lowercase letters, digits, hyphens, underscores, unique",
      "Duplicate ID requires explicit overwrite; generates a downloadable archive"
    ],
    "acceptance": "A 64x64 icon returns VALIDATION_ERROR, and a duplicate ID without overwrite=true returns CONFLICT.",
    "source": "https://docs.cpanel.net/whm/development/cpanel-plugin-file-generator/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "hooks-manager",
    "behaviors": [
      "Grouped by hook category then execution order; search; expand/collapse",
      "Columns: event and hook location, stage (pre/post), attribute icons (blocking, enabled, manual, check, rollback), actions",
      "Enable/disable, move up/down, delete with confirmation; creation only via CLI/API"
    ],
    "acceptance": "Disabling a pre-stage hook stops it running on the next matching event while it stays listed, and moving another hook above it changes execution order accordingly.",
    "source": "https://docs.cpanel.net/whm/development/manage-hooks/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "all",
    "upstreamApi": "list_hooks, edit_hook, delete_hook, reorder_hooks",
    "absorbed": []
  },
  {
    "id": "webmail-signin",
    "behaviors": [
      "Login form takes the full email address plus the mailbox password",
      "Reachable on a dedicated TLS port / webmail.<domain> host, and from the xPanel mailbox list through a one-click open action that issues a short-lived single-use token",
      "If 2FA is enabled for the mailbox a TOTP step follows the password step",
      "Optional 'open my inbox on login' flag skips the home page",
      "Logout destroys the server-side session; idle sessions expire",
      "Suspended mailboxes, or mailboxes whose login is disabled, cannot sign in"
    ],
    "acceptance": "POST /xmail/login with a correct address and password returns a session cookie; the same call for a suspended mailbox returns 403 ACCOUNT_SUSPENDED and sets no cookie; 5 bad passwords from one IP within 10 minutes returns 429 LOGIN_LOCKED.",
    "source": "https://docs.cpanel.net/webmail/the-webmail-interface/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-home",
    "behaviors": [
      "Header shows current disk usage; clicking it opens Manage Disk Usage",
      "Account menu keyed by the email address; the user can star one tool as the default landing page",
      "Tiles grouped as Manage Inbox (autoresponders, filters, forwarders), Calendars and Contacts, Edit Settings, Fight Spam, Other Features",
      "'Set up email on a device' emails setup instructions or offers device configuration profiles",
      "General information panel shows the login name and a stable account UUID",
      "Client chooser: xMail ships one native web client; third-party clients connect over IMAP/SMTP"
    ],
    "acceptance": "For a mailbox using 250 MB of a 1 GB quota, GET /xmail/home shows 250 MB of 1 GB (about 24%) and renders only tiles whose plan feature is enabled; a disabled feature's tile is absent and its route returns 403 FEATURE_DISABLED.",
    "source": "https://docs.cpanel.net/webmail/the-webmail-interface/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "WebmailApps::list_webmail_apps",
    "absorbed": []
  },
  {
    "id": "webmail-folders",
    "behaviors": [
      "Default folders Inbox, Drafts, Sent, Junk, Trash and Archive, mapped to IMAP special-use flags",
      "Create takes a name, an optional parent (or top level) and a list view mode (flat list or threads)",
      "Delete asks for confirmation; a folder that still has subfolders must be emptied of them first",
      "Subscribe or unsubscribe controls whether a folder shows in the folder pane",
      "Folder pane shows unread counts; Trash and Junk offer an Empty action",
      "Rename keeps messages and moves subfolders with the parent"
    ],
    "acceptance": "Creating 'Projects' under parent Inbox creates IMAP folder INBOX.Projects visible via IMAP LIST; deleting or renaming Inbox, Sent, Drafts or Trash returns 409 PROTECTED_FOLDER; creating a duplicate name under the same parent returns 409 FOLDER_EXISTS.",
    "source": "https://docs.cpanel.net/knowledge-base/webmail/how-to-manage-webmail-folders/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-message-list",
    "behaviors": [
      "Three panes: folders, message list, preview",
      "List or threaded conversation view per folder",
      "Sort by date, sender, subject or size, with pagination",
      "Flag icons for unread, flagged, answered and forwarded",
      "Bulk select to move, copy, delete, archive, mark read or unread",
      "Drag-and-drop onto a folder moves messages",
      "Delete moves to Trash; deleting inside Trash removes permanently"
    ],
    "acceptance": "Dragging 3 selected messages from Inbox to Archive lowers the Inbox IMAP count by 3 and raises Archive by 3 with the same Message-IDs; deleting a message while in Trash expunges it so its UID no longer exists.",
    "source": "https://docs.cpanel.net/webmail/webmail-clients/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-message-read",
    "behaviors": [
      "Opening marks the message read, optionally after a delay",
      "HTML is sanitized: scripts, forms and event handlers removed; remote images blocked until allowed for this message or sender",
      "Compact header summary with expandable full headers",
      "View raw source and download as .eml",
      "Print view",
      "Next and previous navigation inside the folder"
    ],
    "acceptance": "A message whose HTML contains a script tag and an onerror handler renders with neither executing, and an external image URL is not requested until the user clicks show images.",
    "source": "https://docs.cpanel.net/webmail/webmail-clients/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-compose",
    "behaviors": [
      "Fields: From identity, To, Cc, Bcc, Subject, body, optional priority and read-receipt request",
      "Plain-text or HTML editor; preference can force HTML always",
      "Spell check",
      "Autosave to Drafts periodically and when leaving the page",
      "Recipient autocomplete from address books and recent recipients",
      "Send goes through authenticated SMTP submission and stores a copy in Sent",
      "Plan outbound rate limits apply"
    ],
    "acceptance": "Sending stores exactly one copy in Sent with Message-ID and Date headers and removes the draft; a send that exceeds the mailbox's hourly outbound limit returns 429 SEND_RATE_LIMITED and nothing is queued.",
    "source": "https://docs.cpanel.net/webmail/webmail-clients/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-reply-forward",
    "behaviors": [
      "Reply targets Reply-To or From; Reply-All adds the other recipients minus the user's own identities",
      "Subject gets Re: or Fwd: without stacking duplicates",
      "Sets In-Reply-To and References for threading",
      "Forward inline as a quote or as an attached .eml; original attachments carried on forward",
      "Original message receives the answered or forwarded flag after send",
      "Identity auto-selected from the address the original was sent to"
    ],
    "acceptance": "Replying to a message with Message-ID <a@x> sends a message whose In-Reply-To is <a@x>, whose References contain <a@x>, whose subject is 'Re: <original>' (never 'Re: Re:'), and the original gains the IMAP Answered flag.",
    "source": "https://docs.cpanel.net/webmail/webmail-clients/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-attachments",
    "behaviors": [
      "Add through a file picker or drag-and-drop with per-file progress",
      "Total attachment size per message limited (configurable, default 25 MB)",
      "Inline images embedded by Content-ID in HTML mail",
      "In-browser preview for images and PDF; other types download",
      "Download all attachments of a message as one zip",
      "Non-ASCII file names encoded per RFC 2231"
    ],
    "acceptance": "Adding files whose total exceeds the configured limit returns 413 ATTACHMENT_TOO_LARGE and the draft keeps its earlier attachments; downloading an attachment named with Arabic characters returns the same name and a SHA-256 identical to the uploaded file.",
    "source": "https://docs.cpanel.net/webmail/webmail-clients/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-search",
    "behaviors": [
      "Quick search over subject, from and to, with optional body",
      "Scope: current folder, folder with subfolders, or all folders",
      "Filters: unread, flagged, has attachment, date range",
      "Results behave like normal list rows and can be bulk-moved",
      "Backed by a server full-text index for large mailboxes"
    ],
    "acceptance": "With a message containing 'invoice-7781' only in its body inside Archive, an all-folders body search returns exactly that message and a current-folder search from Inbox returns none.",
    "source": "https://docs.cpanel.net/webmail/webmail-clients/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-search-index",
    "behaviors": [
      "Single Reindex action queues a full rescan of every folder",
      "Shows queued, running and finished states",
      "Host can hide the tool per plan",
      "Search keeps working during reindex, possibly with partial results"
    ],
    "acceptance": "POST /xmail/search-index/rebuild queues one job; a second call while it runs returns 409 REINDEX_IN_PROGRESS; after completion a message imported directly into the maildir is found by a body search.",
    "source": "https://docs.cpanel.net/webmail/other-webmail-features/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-spam-marking",
    "behaviors": [
      "Mark as junk moves selected messages to Junk and records a spam training sample",
      "Not junk moves them back to Inbox and records a ham sample",
      "Junk messages carry a distinct icon",
      "Bulk empty of Junk after confirmation"
    ],
    "acceptance": "Marking a message as junk moves it to Junk and adds one spam sample to that mailbox's learner store; marking it not junk returns it to Inbox with the same Message-ID and adds one ham sample.",
    "source": "https://docs.cpanel.net/webmail/webmail-clients/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-preferences",
    "behaviors": [
      "Light or dark scheme, defaulting to the browser setting",
      "Interface language including Arabic with right-to-left layout",
      "Time zone and date format",
      "Compose HTML: never, always, or only when replying to HTML",
      "Messages per page and default list or thread view",
      "Mark-as-read delay"
    ],
    "acceptance": "Setting compose HTML to always opens the HTML editor for new messages; choosing Arabic sets dir=rtl on the page root and the choice persists after logout and login.",
    "source": "https://docs.cpanel.net/knowledge-base/webmail/how-to-set-up-a-signature-in-webmail/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-address-book",
    "behaviors": [
      "Contact fields: display name, given and family name, several emails, phones, organization, postal address, notes, photo",
      "Contact groups to address many people at once",
      "Import and export vCard and CSV",
      "Add sender to contacts from an opened message",
      "A default address book is created with the mailbox and cannot be deleted",
      "Same data served to devices over CardDAV"
    ],
    "acceptance": "Importing a .vcf holding 3 contacts creates 3 entries that appear both in the web UI and in a CardDAV REPORT on the default address book; deleting the default address book returns 409 DEFAULT_COLLECTION.",
    "source": "https://docs.cpanel.net/cpanel/email/calendars-and-contacts-management/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-dav-collections",
    "behaviors": [
      "Create: pick type (calendar, address book, task list), a name and optional description; color applies to calendars only",
      "Edit name, description and calendar color",
      "Delete after confirmation",
      "Default calendar and default address book exist from mailbox creation and are undeletable",
      "Plan feature can hide this tool"
    ],
    "acceptance": "Creating a calendar named 'Team' with a color makes it discoverable by a CalDAV PROPFIND on the principal; giving an address book a color returns 422 COLOR_NOT_SUPPORTED; deleting the default calendar returns 409 DEFAULT_COLLECTION.",
    "source": "https://docs.cpanel.net/cpanel/email/calendars-and-contacts-management/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-dav-config",
    "behaviors": [
      "Displays the CalDAV and CardDAV base URL over TLS, username = full email address",
      "Lists a direct URL per collection for clients without discovery",
      "Supports .well-known caldav/carddav redirects and SRV records",
      "Offers a downloadable device profile for one-tap setup"
    ],
    "acceptance": "GET /.well-known/caldav on the mailbox domain redirects to the principal URL, and a CalDAV client logged in with the mailbox credentials discovers the default calendar.",
    "source": "https://docs.cpanel.net/webmail/calendars-and-contacts-in-webmail/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-dav-sharing",
    "behaviors": [
      "Sharing only between mailboxes of the same hosting account",
      "Read-only is the default level; Allow Editing / Disallow Editing switch later",
      "Table shows owner, collection, path, recipient, permission and actions",
      "Deleting a share revokes the recipient's access after confirmation",
      "Replaces the older calendar delegation tool"
    ],
    "acceptance": "Sharing A's calendar read-only with B lets B read events while a PUT by B returns 403 READ_ONLY_SHARE; sharing with a mailbox of another hosting account returns 422 SHARE_TARGET_INVALID.",
    "source": "https://docs.cpanel.net/cpanel/email/calendars-and-contacts-sharing/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "CCS::add_delegate",
    "absorbed": []
  },
  {
    "id": "webmail-calendar",
    "behaviors": [
      "Day, week and month views; create, edit, move and delete events",
      "Recurring events and reminders",
      "Email invitations to attendees; on a shared calendar only the event creator can invite",
      "Only directly invited users can accept an invitation",
      "Import and export .ics"
    ],
    "acceptance": "On a calendar shared with edit rights, B can change the time of an event A created, but adding attendees to it returns 403 NOT_EVENT_ORGANIZER.",
    "source": "https://docs.cpanel.net/cpanel/email/calendars-and-contacts-sharing/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-email-filters",
    "behaviors": [
      "A filter is a name plus one or more conditions plus one or more actions",
      "Condition fields: From, Subject, To, reply address, body, any header, any recipient, not yet delivered, bounce/error message, List-Id, spam status, spam bar, spam score",
      "Text operators: equals, contains, does not contain, begins with, does not begin, ends with, does not end, matches regex, does not match; spam score uses above, not above, below, not below",
      "Conditions joined by and/or, with and evaluated before or",
      "Actions: deliver to folder, redirect to address, fail with a message to the sender, stop processing, discard silently, pipe to a program (plan-gated)",
      "Filters run top to bottom; new ones are appended; drag to reorder",
      "Edit, rename and delete with confirmation"
    ],
    "acceptance": "A filter 'Subject contains invoice' with action deliver to INBOX.Billing files a matching delivery there; conditions 'A or B and C' compile as A or (B and C); adding a pipe action on a plan without pipe permission returns 403 FEATURE_DISABLED.",
    "source": "https://docs.cpanel.net/knowledge-base/email/how-to-configure-email-filters/",
    "upstreamFeatureKey": "blockers",
    "upstreamAcl": "",
    "upstreamApi": "Email::store_filter",
    "absorbed": []
  },
  {
    "id": "webmail-filter-test",
    "behaviors": [
      "Text box accepts headers plus body",
      "Trace marks each condition true or false",
      "Shows sender, recipient, the filter set used and the final disposition (normal delivery, folder, redirect, discard, fail)",
      "Dry run: nothing is delivered or sent"
    ],
    "acceptance": "Testing 'Subject: invoice 42' against the Billing filter returns a trace with the subject condition true and disposition save to INBOX.Billing, and no message is written to any folder.",
    "source": "https://docs.cpanel.net/cpanel/email/email-filters/",
    "upstreamFeatureKey": "blockers",
    "upstreamAcl": "",
    "upstreamApi": "Email::trace_filter",
    "absorbed": []
  },
  {
    "id": "webmail-autoresponder",
    "behaviors": [
      "One autoresponder per address",
      "Fields: character set (default UTF-8), interval in hours before replying again to the same sender (0 = every message), From name, Subject, HTML flag, Body",
      "Body placeholders for the incoming subject, sender name (falling back to address) and sender address",
      "Start immediately or at a set time; stop never or at a set time after the start",
      "No reply to mail scoring as spam (score 5 or higher), bounces, list mail or itself"
    ],
    "acceptance": "With interval 24, two messages from one sender inside 24 hours produce exactly one reply; a stop time before the start returns 422 INVALID_SCHEDULE; creating a second autoresponder for the same address returns 409 AUTORESPONDER_EXISTS.",
    "source": "https://docs.cpanel.net/webmail/manage-your-inbox-in-webmail/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Email::add_auto_responder",
    "absorbed": []
  },
  {
    "id": "webmail-forwarders",
    "behaviors": [
      "Add one or more destination addresses for the signed-in mailbox",
      "The mailbox keeps its own copy as well",
      "Searchable list; delete with confirmation",
      "Trace shows the route a forwarded message would take",
      "Mailboxes using challenge-response manage forwarding inside that tool",
      "Loops and forwarding to itself are refused"
    ],
    "acceptance": "After adding ext@example.org, a test delivery leaves one local copy and queues one outbound copy to ext@example.org; adding the mailbox's own address returns 422 FORWARD_LOOP.",
    "source": "https://docs.cpanel.net/webmail/manage-your-inbox-in-webmail/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Email::add_forwarder",
    "absorbed": []
  },
  {
    "id": "webmail-plus-addressing",
    "behaviors": [
      "Option 1: create the folder if missing and deliver there",
      "Option 2: never create folders; deliver to Inbox when the folder is missing",
      "Existing folders always receive their tagged mail"
    ],
    "acceptance": "With auto-create on, mail to user+news@example.com creates INBOX.news and lands in it; with it off, the same mail lands in INBOX and no folder is created.",
    "source": "https://docs.cpanel.net/webmail/edit-your-settings-in-webmail/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Email::enable_mailbox_autocreate",
    "absorbed": []
  },
  {
    "id": "webmail-password",
    "behaviors": [
      "New password entered twice",
      "Generator with length and character-class options; user confirms the password was saved before using it",
      "Server minimum strength enforced",
      "Changing the password ends other sessions",
      "Settings that belong to the hosting account owner are hidden"
    ],
    "acceptance": "A password below the server's minimum strength returns 422 WEAK_PASSWORD; after a successful change IMAP login with the old password fails and with the new one succeeds, and other webmail sessions are logged out.",
    "source": "https://docs.cpanel.net/webmail/edit-your-settings-in-webmail/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Email::passwd_pop",
    "absorbed": []
  },
  {
    "id": "webmail-identities",
    "behaviors": [
      "Identity fields: display name, address (the mailbox or an alias it controls), organization, reply-to, bcc, signature",
      "Signature in plain text or HTML; HTML can embed small images",
      "Image signatures appear only in HTML composition",
      "One default identity; options to add the signature on new mail, replies and forwards, above or below the quote",
      "Create, edit, delete; the last identity cannot be deleted"
    ],
    "acceptance": "Creating an identity with an address the mailbox does not control returns 403 IDENTITY_NOT_OWNED; switching identity in compose replaces the signature without duplicating it.",
    "source": "https://docs.cpanel.net/knowledge-base/webmail/how-to-set-up-a-signature-in-webmail/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-contact-info",
    "behaviors": [
      "One or more notification addresses plus an optional push-service token",
      "Warning against notification addresses hosted on the same server",
      "Login alert: at most one notice per 24 h per user, service and IP, skipping previously used locations",
      "Option to alert even for IPs in a previously used network range",
      "A notice is sent if login alerts are switched off"
    ],
    "acceptance": "With login alerts on, a login from a new IP sends one notice, a second login from the same IP and service within 24 h sends none, and turning alerts off sends a notice to the stored address.",
    "source": "https://docs.cpanel.net/webmail/edit-your-settings-in-webmail/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-two-factor",
    "behaviors": [
      "Available only when the server administrator enables 2FA",
      "Setup shows a QR code and text secret; enrollment confirmed with a current code",
      "Login then requires password plus code",
      "Removal requires re-authentication",
      "Enrollment does not move with server transfers; users re-enroll"
    ],
    "acceptance": "Confirming setup with a wrong code returns 422 INVALID_TOTP and 2FA stays off; once on, a login with only the password returns 401 TOTP_REQUIRED.",
    "source": "https://docs.cpanel.net/webmail/edit-your-settings-in-webmail/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "TwoFactorAuth::set_user_configuration",
    "absorbed": []
  },
  {
    "id": "webmail-external-auth",
    "behaviors": [
      "List linked providers; link and unlink",
      "Several providers may be linked to one mailbox",
      "Only providers configured by the server admin are offered (no vendor-branded identity service)",
      "Provider-side 2FA applies"
    ],
    "acceptance": "After unlinking a provider, an OIDC login through it returns 401 IDENTITY_NOT_LINKED while password login still works.",
    "source": "https://docs.cpanel.net/webmail/edit-your-settings-in-webmail/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-analytics-consent",
    "behaviors": [
      "Prompt repeats until a choice is saved"
    ],
    "acceptance": "No analytics consent prompt appears and no request leaves to a non-panel host from any xMail page.",
    "source": "https://docs.cpanel.net/webmail/the-webmail-interface/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webmail-spam-autodelete",
    "behaviors": [
      "Choice: custom threshold or disabled",
      "Whole number 1 to 50; lower values delete more; UI suggests 15 or higher",
      "Mail meeting or exceeding the threshold is deleted, not moved",
      "Per-mailbox value stays within limits set by the hosting account owner"
    ],
    "acceptance": "Threshold 0 or 51 returns 422 OUT_OF_RANGE; with threshold 10 a delivery scored 12 is discarded and logged while one scored 9 is delivered.",
    "source": "https://docs.cpanel.net/webmail/fight-spam-in-webmail/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Email::add_spam_filter",
    "absorbed": []
  },
  {
    "id": "webmail-spam-box",
    "behaviors": [
      "Toggle on or off",
      "Flagged messages go to Junk with the spam headers kept",
      "Works together with the auto-delete threshold (deletion wins)"
    ],
    "acceptance": "With the spam folder on, a message carrying a spam status of Yes lands in Junk; with it off the same message lands in Inbox.",
    "source": "https://docs.cpanel.net/cpanel/email/spam-filters/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Email::enable_spam_box",
    "absorbed": []
  },
  {
    "id": "webmail-boxtrapper",
    "behaviors": [
      "Enable or disable; only when the host allows it; addresses the user writes to are auto-allowed",
      "Settings: other addresses that feed this mailbox, display name, days to keep logs and queued mail, minimum spam score that bypasses the trap (default -2.5), automatic allow-listing, allow-listing by association (To/Cc of allowed senders)",
      "Editable verify and block reply templates with sender and subject placeholders; reset to default",
      "Lists: allow (deliver), ignore (drop silently), block (drop and tell sender)",
      "Forward list receiving copies of allowed mail",
      "Per-day log and review queue with delete or allow-and-deliver"
    ],
    "acceptance": "With the trap on, mail from an unknown sender is queued and exactly one verification message is sent; when the sender answers the token the mail is delivered and the sender is allow-listed; mail from a blocked sender is dropped and a block notice is sent.",
    "source": "https://docs.cpanel.net/webmail/fight-spam-in-webmail/",
    "upstreamFeatureKey": "boxtrapper",
    "upstreamAcl": "",
    "upstreamApi": "BoxTrapper::set_status",
    "absorbed": []
  },
  {
    "id": "webmail-quota",
    "behaviors": [
      "Header meter: used, quota and percent; unlimited shown with an infinity sign",
      "Warning state at 80% and critical at 95% (configurable)",
      "Values may lag briefly because of caching; manual refresh",
      "A full mailbox defers or rejects incoming mail and blocks saving drafts"
    ],
    "acceptance": "A 100 MB mailbox holding 96 MB shows 96% in the critical style, and saving a 5 MB draft returns 507 QUOTA_EXCEEDED.",
    "source": "https://docs.cpanel.net/webmail/the-webmail-interface/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Email::get_pop_quota",
    "absorbed": []
  },
  {
    "id": "webmail-disk-cleanup",
    "behaviors": [
      "Table of folders with message count and size; sortable; filter by name",
      "Per folder: remove messages a year old or more, 30 MB or larger, already read, all, or a custom server search query",
      "Delete Permanently with no recycle step",
      "An empty custom query is refused so a folder cannot be wiped by accident"
    ],
    "acceptance": "Running 'larger than 30 MB' on a folder with 2 such and 10 smaller messages expunges exactly 2 and lowers the folder size accordingly; an empty custom query returns 422 QUERY_REQUIRED.",
    "source": "https://docs.cpanel.net/cpanel/email/email-disk-usage/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Mailboxes::expunge_mailbox_messages",
    "absorbed": []
  },
  {
    "id": "webmail-mail-client-setup",
    "behaviors": [
      "Username is the full email address; password is the mailbox password",
      "Secure ports: IMAP 993, POP3 995, SMTP 465; non-TLS: IMAP 143, POP3 110, SMTP 587",
      "Host is mail.<domain> when it has a valid certificate, otherwise the server hostname",
      "Recommends IMAP over POP3",
      "Auto-setup: Apple profile, Thunderbird-style autoconfig XML, Outlook-style autodiscover",
      "Email the instructions to an address"
    ],
    "acceptance": "GET /.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=u@example.com returns IMAP 993 SSL and SMTP 465 SSL with username u@example.com; sending instructions to an invalid address returns 422 INVALID_EMAIL.",
    "source": "https://docs.cpanel.net/cpanel/email/set-up-mail-client/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "Email::get_client_settings",
    "absorbed": []
  },
  {
    "id": "webmail-track-delivery",
    "behaviors": [
      "Optional recipient filter; Run Report",
      "Quick filters: blocked and failed only, or all",
      "Default view: the 250 most recent events with status (delivered, in progress, deferred, error, archived, rejected, filtered) and a detail view",
      "Checkboxes for success, deferred, failure, in-progress and a max-results selector",
      "Column chooser: sender, recipient, spam score, delivery host, size, result",
      "Route trace diagram for an address",
      "Retention set by the host"
    ],
    "acceptance": "After sending to a non-existent remote recipient, the blocked-and-failed view lists that message with status error and the remote SMTP reply, and events of other mailboxes never appear in this user's report.",
    "source": "https://docs.cpanel.net/webmail/other-webmail-features/",
    "upstreamFeatureKey": "emailtrace",
    "upstreamAcl": "",
    "upstreamApi": "EmailTrack::search",
    "absorbed": []
  },
  {
    "id": "webmail-mailing-lists",
    "behaviors": [
      "Table: list address, disk usage, access level, administrators, actions",
      "Private lists need admin approval to subscribe and are hidden from the public index; public lists allow open subscription",
      "Manage opens list administration with single sign-on",
      "List spam rules require spam filtering enabled on the account"
    ],
    "acceptance": "A mailbox that administers no list sees an empty table; a self-subscribe to a private list stays pending until an admin approves it.",
    "source": "https://docs.cpanel.net/webmail/other-webmail-features/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-firewall-switch",
    "behaviors": [
      "Single toggle with a warning when disabling",
      "Inbound traffic not matched by an allow rule is dropped",
      "Panel, SSH, HTTP and HTTPS ports are auto-allowed on enable to prevent lockout",
      "Backend-agnostic (nftables, firewalld or ufw)"
    ],
    "acceptance": "Enabling the firewall with no custom rules keeps the panel port, SSH port, 80 and 443 reachable while a probe to port 8081 times out; disabling reopens it.",
    "source": "https://www.aapanel.com/docs/Function/Security.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-icmp-block",
    "behaviors": [
      "Toggle; on means the server ignores ping",
      "Persists across reboots and firewall reloads"
    ],
    "acceptance": "With the toggle on an external ping gets no reply; turning it off restores replies; the state survives a reboot.",
    "source": "https://www.aapanel.com/docs/Function/Security.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-port-rules",
    "behaviors": [
      "Fields: protocol (TCP, UDP or both), port (1-65535 or a range), source (any or a specific IP/CIDR), action allow or deny, direction inbound or outbound, remark",
      "Columns add listening status with the owning process and creation time",
      "Filter by direction; edit and delete",
      "Duplicate rules rejected"
    ],
    "acceptance": "Adding TCP port 70000 returns 422 INVALID_PORT; an allow rule for TCP 8080 from 203.0.113.5 lets only that IP connect; the list marks 8080 listening only while a process binds it.",
    "source": "https://www.aapanel.com/docs/Function/Security.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-ip-rules",
    "behaviors": [
      "Fields: address (single, CIDR or range), action block or release, direction, remark",
      "Separate inbound and outbound tabs",
      "A block applies to all ports",
      "A release overrides region blocks for that address"
    ],
    "acceptance": "Blocking 198.51.100.7 inbound makes every port unreachable from it within 5 seconds while other IPs are unaffected; a malformed address returns 422 INVALID_IP.",
    "source": "https://www.aapanel.com/docs/Function/Security.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-port-forward",
    "behaviors": [
      "Fields: protocol TCP or UDP, source port, target IP (127.0.0.1 for local), target port, remark",
      "Implemented with NAT rules; kernel forwarding enabled when needed",
      "Conflicting source ports flagged"
    ],
    "acceptance": "Forwarding TCP 2222 to 127.0.0.1:22 lets an external SSH client connect on 2222; reusing a source port already forwarded returns 409 PORT_IN_USE.",
    "source": "https://www.aapanel.com/docs/Function/Security.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-region-rules",
    "behaviors": [
      "Default is allow; rules can only block",
      "Fields: one or more regions, all ports or a specific port",
      "IP-to-region dataset updated periodically, with an accuracy warning",
      "Release your own ranges first; IP release rules take precedence",
      "Edit and delete"
    ],
    "acceptance": "Blocking region XX on port 22 drops SSH from an address in that region's prefix list while 443 stays reachable; an address with an IP release rule still connects.",
    "source": "https://www.aapanel.com/docs/Function/Security.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-firewall-import-export",
    "behaviors": [
      "Export per rule type",
      "Import validates every row and reports the failing line; nothing is applied if any row is invalid",
      "Duplicates are skipped"
    ],
    "acceptance": "Exporting port rules and importing the file on a clean server recreates identical rules; a file with one invalid row returns 422 IMPORT_INVALID naming the line and applies nothing.",
    "source": "https://www.aapanel.com/docs/Function/Security.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-ssh-service",
    "behaviors": [
      "Toggle start/stop; the service starts again after a reboot",
      "Counters: total and today's successful and failed logins"
    ],
    "acceptance": "Stopping SSH from the panel makes port 22 refuse connections while the panel stays up; today's counters equal the counts parsed from the auth log.",
    "source": "https://www.aapanel.com/docs/Function/Security.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-ssh-settings",
    "behaviors": [
      "Toggle password authentication and public-key authentication",
      "Change the port (default 22); firewall opened for the new port",
      "Root login policy: key or password, denied, key only, forced commands only",
      "Config validated before reload and backed up"
    ],
    "acceptance": "Setting port 22022 updates the daemon config, opens 22022 in the firewall and a key login on 22022 succeeds; turning off both password and key login returns 422 NO_AUTH_METHOD.",
    "source": "https://www.aapanel.com/docs/Function/Security.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "ssh-password-auth",
        "name": "SSH Password Login",
        "source": "https://docs.cpanel.net/whm/security-center/ssh-password-authorization-tweak/",
        "behaviors": [
          "Enable/disable buttons edit the SSH daemon config",
          "Also applies to root; warns to install root keys first",
          "When off, every SSH user must use keys"
        ]
      }
    ]
  },
  {
    "id": "aapanel-ssh-login-alarm",
    "behaviors": [
      "Toggle",
      "Message includes source IP, user and time",
      "Uses the panel's notification channels"
    ],
    "acceptance": "With the alert on and a webhook channel configured, one root SSH login produces exactly one webhook call containing the source IP.",
    "source": "https://www.aapanel.com/docs/Function/Security.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-ssh-login-logs",
    "behaviors": [
      "Filters: all, success, failure; refresh",
      "Columns: IP and port, approximate location, user, status, time",
      "Advice to change port and enable IP lockout when failures pile up"
    ],
    "acceptance": "Three failed and one successful login yield 4 rows, and the failure filter shows exactly 3.",
    "source": "https://www.aapanel.com/docs/Function/Logs.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-anti-intrusion",
    "behaviors": [
      "Per-user protection and logging toggles, process allow list, logs"
    ],
    "acceptance": "Not built; the menu entry is absent from xPanel.",
    "source": "https://www.aapanel.com/docs/Function/Professional.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-system-hardening",
    "behaviors": [
      "Protection items with on/off and protected paths"
    ],
    "acceptance": "Not built; the menu entry is absent from xPanel.",
    "source": "https://www.aapanel.com/docs/Function/Professional.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-site-list",
    "behaviors": [
      "Columns: name (opens settings), running/stopped (click toggles), backup count, document root (opens file manager), quota, expiry, note, PHP version, SSL status with days left",
      "Search by domain or note; filter by category; sort and paginate",
      "Row actions: settings and delete"
    ],
    "acceptance": "Searching 'shop' returns only sites whose domain or note contains 'shop', and the SSL column shows days left computed from the certificate expiry.",
    "source": "https://www.aapanel.com/docs/Function/php.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-site-bulk-actions",
    "behaviors": [
      "Multi-select in the list",
      "Per-site result reporting",
      "Delete prompts to back up first"
    ],
    "acceptance": "Setting PHP 8.2 on 5 selected sites updates all 5 vhosts and returns 5 per-site results; bulk delete moves each root into the recycle bin.",
    "source": "https://www.aapanel.com/docs/Function/php.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-site-start-stop",
    "behaviors": [
      "Stop swaps the vhost to the stopped-page template",
      "Start restores the normal vhost",
      "Status shown in the list"
    ],
    "acceptance": "After stopping, any path returns the stopped page; after starting, the original content returns 200.",
    "source": "https://www.aapanel.com/docs/SubaaPanel/Website.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-site-expiry",
    "behaviors": [
      "Date or permanent",
      "Daily job stops expired sites",
      "Optional alert before expiry"
    ],
    "acceptance": "A site whose expiry was yesterday is stopped by the next scheduler run and shows as expired; setting permanent clears it.",
    "source": "https://www.aapanel.com/docs/Function/php.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-site-quota",
    "behaviors": [
      "Limit in MB",
      "Only on XFS project quota; otherwise disabled with an explanation"
    ],
    "acceptance": "On a non-XFS filesystem setting a quota returns 422 QUOTA_UNSUPPORTED_FS; on XFS a write past the limit fails with a quota error.",
    "source": "https://www.aapanel.com/docs/Function/php.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-default-site",
    "behaviors": [
      "Pick a site or none",
      "None means the unbound-domain page is served"
    ],
    "acceptance": "With default site A, a request with an unknown Host header or the server IP is served by A; with none, the unbound-domain page is returned.",
    "source": "https://www.aapanel.com/docs/Function/php.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-site-directory",
    "behaviors": [
      "Change document root",
      "Run directory such as /public for frameworks",
      "Cross-site isolation via a per-site open_basedir file",
      "Access log on or off",
      "Whole-site password with username and password"
    ],
    "acceptance": "With isolation on, PHP in site A cannot read site B's files; with run directory /public, '/' serves public/index.php.",
    "source": "https://www.aapanel.com/docs/Function/php.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-deny-access",
    "behaviors": [
      "Fields: name, directory, extensions",
      "Matching requests get 403"
    ],
    "acceptance": "Denying php under /uploads makes /uploads/x.php return 403 while /uploads/x.jpg returns 200.",
    "source": "https://www.aapanel.com/docs/Function/php.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-traffic-control",
    "behaviors": [
      "Total concurrent connections per site",
      "Concurrent connections per client IP",
      "Bandwidth per connection",
      "Presets plus custom; on/off"
    ],
    "acceptance": "With per-IP concurrency 2, a third parallel request from one IP gets 503 while another IP is served.",
    "source": "https://www.aapanel.com/docs/Function/php.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-url-rewrite",
    "behaviors": [
      "Template picker per application",
      "Apache uses .htaccess in the root by default",
      "Nginx rules kept in a per-site include",
      "Validated before reload; rules must be redone after switching web server",
      "Save as a custom template"
    ],
    "acceptance": "Saving an Nginx rule with a syntax error returns 422 CONFIG_TEST_FAILED with the test output and the previous rules stay active.",
    "source": "https://www.aapanel.com/docs/Function/php.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-default-index",
    "behaviors": [
      "Comma-separated ordered list",
      "Applied to the vhost"
    ],
    "acceptance": "With 'home.html,index.php', '/' serves home.html when both files exist.",
    "source": "https://www.aapanel.com/docs/Function/php.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-site-config-editor",
    "behaviors": [
      "Full-text editor",
      "Panel-managed marker comments must stay; warning if removed",
      "Test before reload; automatic rollback on failure"
    ],
    "acceptance": "Saving an invalid config returns 422 CONFIG_TEST_FAILED and the running config is unchanged; removing a managed marker returns 422 MARKER_REQUIRED.",
    "source": "https://www.aapanel.com/docs/Function/php.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-composer",
    "behaviors": [
      "Choose action, PHP binary and target directory",
      "Optional package mirror",
      "Live log output"
    ],
    "acceptance": "Running install on a folder with composer.json creates vendor/ owned by the site user; a folder without composer.json returns 422 COMPOSER_JSON_MISSING.",
    "source": "https://www.aapanel.com/docs/Function/php.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-site-reverse-proxy",
    "behaviors": [
      "Scope: whole site or a sub-path",
      "Target URL, Host header to send, timeout",
      "Custom directives",
      "Response text replacement",
      "Cache and gzip toggles",
      "IP block and allow lists per path",
      "WebSocket upgrade"
    ],
    "acceptance": "Proxying /api/ to http://127.0.0.1:3000 returns the backend's response for /api/x with the configured Host; a target that is not http or https returns 422 INVALID_TARGET.",
    "source": "https://www.aapanel.com/docs/Function/proxy.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-proxy-project",
    "behaviors": [
      "List: domain, target, SSL, note",
      "Settings: domains, proxy rules, cache, compression, IP lists, HTTP auth, logs (off, custom path, remote log server), WebSocket, custom config, SSL, redirect, hotlink, logs",
      "The last proxy rule cannot be deleted"
    ],
    "acceptance": "Deleting the only proxy rule of a proxy project returns 409 LAST_PROXY_RULE.",
    "source": "https://www.aapanel.com/docs/Function/proxy.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-https-protection",
    "behaviors": [
      "Global advanced toggle"
    ],
    "acceptance": "With protection on, a TLS request for a domain that has no HTTPS config is refused instead of served another site.",
    "source": "https://www.aapanel.com/docs/Function/php.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-one-click-deploy",
    "behaviors": [
      "Catalog of apps",
      "Creates site, database and files"
    ],
    "acceptance": "Deploying an app creates a site whose home page returns 200 and a database the app config points to.",
    "source": "https://www.aapanel.com/docs/Function/php.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-site-waf",
    "behaviors": [
      "Per-site rule sets"
    ],
    "acceptance": "Not built; the WAF column is absent.",
    "source": "https://www.aapanel.com/docs/Function/Professional.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-site-stats",
    "behaviors": [
      "Traffic, connections, visitors"
    ],
    "acceptance": "Not built; the Stats column is absent.",
    "source": "https://www.aapanel.com/docs/Function/Professional.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-tamper-proof",
    "behaviors": [
      "Protected paths and events"
    ],
    "acceptance": "Not built.",
    "source": "https://www.aapanel.com/docs/Function/Professional.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-business-ssl",
    "behaviors": [
      "Order and install paid certificates"
    ],
    "acceptance": "Not built; only pasted and ACME certificates exist.",
    "source": "https://www.aapanel.com/docs/Function/php.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-wp-toolkit",
    "behaviors": [
      "Local and remote WordPress management"
    ],
    "acceptance": "Not built.",
    "source": "https://www.aapanel.com/docs/Function/WPToolkit-Local.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-panel-port",
    "behaviors": [
      "New port opened in the firewall before the switch",
      "Reminder to open it at the cloud provider",
      "CLI recovery to change it"
    ],
    "acceptance": "Changing to 18888 makes the panel answer on 18888 and the old port stop; a port in use returns 409 PORT_IN_USE; values outside 1-65535 return 422 INVALID_PORT.",
    "source": "https://www.aapanel.com/docs/Function/Settings.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-security-entrance",
    "behaviors": [
      "Random path at install",
      "Login only at that path; other paths get the unauthenticated response",
      "Change path with length and character rules",
      "CLI shows or resets it"
    ],
    "acceptance": "GET /login without the entrance returns the configured response (default 404) and GET /<entrance> returns the login form; an entrance shorter than 8 characters returns 422 ENTRANCE_TOO_SHORT.",
    "source": "https://www.aapanel.com/docs/Function/Settings.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-unauth-response",
    "behaviors": [
      "Choices such as 404, 403, blank page or redirect",
      "Hides that a panel exists"
    ],
    "acceptance": "With 404 chosen, an unauthenticated request to any panel URL returns 404 with no panel branding in the body.",
    "source": "https://www.aapanel.com/docs/Function/Settings.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-panel-domain",
    "behaviors": [
      "Bind a domain",
      "Access by IP returns 403",
      "CLI recovery unbinds"
    ],
    "acceptance": "With panel.example.test bound, requests by IP get 403 and by that name succeed.",
    "source": "https://www.aapanel.com/docs/Function/Settings.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-basic-auth",
    "behaviors": [
      "Username and password separate from the panel login",
      "CLI recovery turns it off"
    ],
    "acceptance": "With BasicAuth on, any panel URL without credentials returns 401 before the login page is shown.",
    "source": "https://www.aapanel.com/docs/Function/Settings.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-temporary-login",
    "behaviors": [
      "Generate link with lifetime",
      "Revoke anytime",
      "Separate activity log",
      "Cannot change security settings"
    ],
    "acceptance": "An expired link returns 401 LINK_EXPIRED, and a temporary session trying to change the panel port returns 403.",
    "source": "https://www.aapanel.com/docs/Function/Settings.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-recovery-cli",
    "behaviors": [
      "Restart, stop, start and reload the panel",
      "Change password, username, port and entrance",
      "Clear login locks",
      "Remove IP and domain restrictions",
      "Turn off BasicAuth or 2FA",
      "Toggle panel SSL",
      "Show panel URL and login info"
    ],
    "acceptance": "Running the reset-allow-list command as root clears the IP list and the panel becomes reachable from any IP; running it as a non-root user exits with code 1 and changes nothing.",
    "source": "https://www.aapanel.com/docs/faq/Panel_Related.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-panel-logs",
    "behaviors": [
      "Operation log: actor, IP, action, time",
      "Run log and cron log",
      "Website operation, access and error logs",
      "FTP and MySQL slow and error logs"
    ],
    "acceptance": "Changing the panel port adds an operation entry with actor, IP and old and new values; deleting operation logs triggers the security alert.",
    "source": "https://www.aapanel.com/docs/Function/Logs.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "aapanel-subpanel-logs",
        "name": "Account Activity Logs",
        "source": "https://www.aapanel.com/docs/Function/Account.html",
        "behaviors": [
          "View and clear"
        ]
      }
    ]
  },
  {
    "id": "aapanel-bind-account",
    "behaviors": [
      "Bind or unbind vendor account"
    ],
    "acceptance": "Not built; no vendor account is required for any xPanel feature.",
    "source": "https://www.aapanel.com/docs/Function/Settings.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "xpanel-tools-home",
    "behaviors": [
      "Show only the tools whose features the account's plan enables",
      "Let the user drag tool groups into a new order and save that order for that user",
      "Offer a 'reset page settings' action that restores the default order",
      "Return to this page when the logo is clicked"
    ],
    "acceptance": "A tool whose feature is disabled for the account is missing from the home page, and opening its route returns FEATURE_DISABLED. A custom group order survives logging out and back in. The reset action restores the default order.",
    "source": "https://docs.cpanel.net/cpanel/the-cpanel-interface/the-cpanel-interface/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "aapanel-subpanel-overview",
        "name": "End-User Overview",
        "source": "https://www.aapanel.com/docs/SubaaPanel/Overview.html",
        "behaviors": [
          "Sites, FTP accounts and databases used against the maximum",
          "Today's requests, live QPS, monthly bandwidth and live traffic",
          "Disk usage, with writes blocked above 100%"
        ]
      }
    ]
  },
  {
    "id": "xpanel-global-search",
    "behaviors": [
      "Match tool names and keywords as the user types",
      "Pressing '/' anywhere moves focus to the search box",
      "Leave tools the account cannot access out of the results"
    ],
    "acceptance": "Pressing '/' focuses the search box. Searching 'forward' returns the Forwarders tool. A tool disabled by the plan never appears in the results.",
    "source": "https://docs.cpanel.net/cpanel/the-cpanel-interface/the-cpanel-interface/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "xpanel-notifications",
    "behaviors": [
      "Show an unread marker while unread items exist",
      "Show messages from the system (such as quota warnings) and from the provider",
      "Mark items as read"
    ],
    "acceptance": "An announcement the provider sends to an account turns on that account's unread marker. Marking it read turns the marker off. Accounts outside the target audience never see it.",
    "source": "https://docs.cpanel.net/cpanel/the-cpanel-interface/the-cpanel-interface/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "xpanel-general-info",
    "behaviors": [
      "Show the username, the primary domain and the state of its certificate",
      "Show whether the IP is shared or dedicated, the home directory path and the IP of the last login",
      "Show the active theme and a link to the server information page"
    ],
    "acceptance": "The 'last login IP' field shows the IP of the previous session, not the current one. A primary domain whose certificate has expired shows the status 'expired'.",
    "source": "https://docs.cpanel.net/cpanel/the-cpanel-interface/the-cpanel-interface/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "xpanel-usage-stats-panel",
    "behaviors": [
      "Show used and limit values for disk, files (inodes), bandwidth, databases, mailboxes, domains and FTP accounts",
      "Flag a resource as a warning once it reaches 80% of its limit",
      "Show a marker for unlimited resources and offer upgrade or manage links"
    ],
    "acceptance": "An account at 81% of its disk quota shows the disk counter in the warning state, and at 79% it does not. A resource with no limit shows an unlimited marker instead of a percentage.",
    "source": "https://docs.cpanel.net/cpanel/the-cpanel-interface/the-cpanel-interface/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "ResourceUsage",
    "absorbed": []
  },
  {
    "id": "xpanel-server-information",
    "behaviors": [
      "Show the plan name, hostname, panel version, web server version and database server versions",
      "Show the OS, architecture, kernel, and the shared, dedicated and local IPs",
      "Show the paths to the mail binary and the script interpreter",
      "List each service as up or down, with its load or memory figure"
    ],
    "acceptance": "When the database service is stopped, the next page refresh shows it as down. The version shown for each component matches the version installed on the host.",
    "source": "https://docs.cpanel.net/cpanel/the-cpanel-interface/server-information-for-cpanel/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "ServerInformation",
    "absorbed": []
  },
  {
    "id": "xpanel-onboarding-assistant",
    "behaviors": [
      "Appear only for accounts that have not finished or dismissed it",
      "Link to the first tasks: add a domain, create a mailbox, publish a site",
      "Can be dismissed permanently"
    ],
    "acceptance": "A newly created account sees the assistant on its first login. Once it is dismissed, it does not come back on later logins.",
    "source": "https://docs.cpanel.net/cpanel/the-cpanel-interface/the-cpanel-interface/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "nginx-cache-control",
    "behaviors": [
      "Turn caching on or off for the whole account",
      "Clear the account's cached content",
      "Show these controls only when the server runs the caching proxy"
    ],
    "acceptance": "After a purge, the first request for a cached URL returns a cache MISS header. After caching is disabled, responses carry a BYPASS status. Calling either action on a server without the proxy returns NOT_AVAILABLE.",
    "source": "https://docs.cpanel.net/cpanel/the-cpanel-interface/the-cpanel-interface/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "NginxCaching",
    "absorbed": []
  },
  {
    "id": "whm-home-favorites",
    "behaviors": [
      "Star or unstar any tool",
      "Reorder favorites and show or hide their descriptions",
      "Show favorites in the side navigation as well"
    ],
    "acceptance": "Starring a tool adds it to both the home favorites and the side menu. The favorites are saved separately for each admin or reseller login.",
    "source": "https://docs.cpanel.net/whm/the-whm-interface/the-whm-interface/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "whm-global-search",
    "behaviors": [
      "Rank exact matches first",
      "Pressing '/' moves focus to the search box",
      "A reseller only gets back accounts they own"
    ],
    "acceptance": "A reseller searching for the username of an account they do not own gets no result. A root search for an exact username shows that account first.",
    "source": "https://docs.cpanel.net/whm/the-whm-interface/the-whm-interface/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "whm-notifications",
    "behaviors": [
      "Turn red while unread items exist",
      "Open a list of the messages",
      "Mark messages as read"
    ],
    "acceptance": "A failed backup run creates an unread item for root, and the icon turns red until the item is read.",
    "source": "https://docs.cpanel.net/whm/the-whm-interface/the-whm-interface/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "incoming-mail-country-filter",
    "behaviors": [
      "Show a list of countries with an allowed or blocked toggle for each",
      "Select all and apply allow or block in one step",
      "Apply this filter before the other mail filters"
    ],
    "acceptance": "With country X blocked, a test SMTP session from an IP mapped to X is rejected with a 5xx code, while an IP from an allowed country is accepted.",
    "source": "https://docs.cpanel.net/whm/email/filter-incoming-emails-by-country/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "incoming-mail-domain-filter",
    "behaviors": [
      "Add sender domains to the block list or remove them",
      "Refuse mail from listed domains before content filtering"
    ],
    "acceptance": "After spam.example is added, a message with MAIL FROM at spam.example is rejected with a 5xx code. After it is removed, the same message is accepted.",
    "source": "https://docs.cpanel.net/whm/email/filter-incoming-emails-by-domain/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "whm-greylisting",
    "behaviors": [
      "Set the initial deferral period, the window in which a retry must arrive, and how long records are kept",
      "Manage trusted hosts and IP ranges that skip greylisting",
      "Optionally trust well-known mail providers"
    ],
    "acceptance": "The first attempt from an unknown sender, recipient and IP combination gets a 451 temporary failure. A retry after the deferral period is accepted. A trusted IP is accepted on the first try.",
    "source": "https://docs.cpanel.net/whm/email/greylisting/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "mail-delivery-reports",
    "behaviors": [
      "Filter by text field, match type, delivery type and a date and time range",
      "Show deliveries, deferrals, failures and in-progress messages, each of which can be toggled",
      "Choose which optional columns to show (sender IP, authentication, router, transport, size) and open a detail view per event",
      "A reseller sees only events for accounts they own"
    ],
    "acceptance": "A reseller's search returns only events for their own accounts. Turning off 'show deliveries' removes every delivered event from the results.",
    "source": "https://docs.cpanel.net/whm/email/mail-delivery-reports/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "track-email",
    "upstreamApi": "emailtrack_search",
    "absorbed": []
  },
  {
    "id": "mail-queue-manager",
    "behaviors": [
      "Search queue metadata by field with begins-with, exact or partial matching and a date range (message bodies are not searched)",
      "View a message, then deliver it now, delete it or return to the queue",
      "Bulk actions: deliver or delete the selected messages, or all of them",
      "Unfreeze a frozen message, one at a time"
    ],
    "acceptance": "Deleting message ID M removes it from the queue, and a second delete returns NOT_FOUND. Unfreezing a message that is not frozen returns NOT_FROZEN.",
    "source": "https://docs.cpanel.net/whm/email/mail-queue-manager/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "mail-troubleshooter",
    "behaviors": [
      "Accept a destination address",
      "On success, show the receiving host's IP, its MX priority and whether DNSSEC is in use",
      "On failure, name the step that failed"
    ],
    "acceptance": "Tracing an address whose domain has no MX or A record returns a failure at the remote-domain lookup step. A valid domain returns at least one MX host with its priority.",
    "source": "https://docs.cpanel.net/whm/email/mail-troubleshooter/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "mailcheck",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "aapanel-mail-viewer",
        "name": "Admin Mail Viewer",
        "source": "https://www.aapanel.com/docs/Function/MailServer.html",
        "behaviors": [
          "Inbox: view, mark as spam, delete",
          "Sent mail and spam views",
          "Send a test message as a chosen user"
        ]
      }
    ]
  },
  {
    "id": "mailbox-format-conversion",
    "behaviors": [
      "Choose the target format",
      "Select the accounts to convert",
      "Optionally keep the old files, and show progress and warnings"
    ],
    "acceptance": "After converting an account to mdbox, every mailbox has the same message count as before. With 'keep old files' set, the maildir files are still on disk.",
    "source": "https://docs.cpanel.net/whm/email/mailbox-conversion/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "repair-mailbox-permissions",
    "behaviors": [
      "Choose all accounts or specific ones",
      "Restore the expected owner and permission modes on mail directories and files",
      "Report each path that was fixed"
    ],
    "acceptance": "If an account's mail directory is changed to be owned by root, running repair returns ownership to the account user and the report lists that path.",
    "source": "https://docs.cpanel.net/whm/email/repair-mailbox-permissions/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "spam-daemon-startup",
    "behaviors": [
      "Allowed client IPs, defaulting to IPv4 and IPv6 loopback, where an empty value means any IP",
      "Maximum connections per child (default 200) and number of child processes (default 1)",
      "TCP timeout (default 30 s) and child timeout (default 300 s), where 0 turns the TCP timeout off"
    ],
    "acceptance": "Saving 0 as the number of child processes is rejected with VALIDATION_ERROR. Saving valid values restarts the daemon with the new arguments.",
    "source": "https://docs.cpanel.net/whm/email/spamd-startup-configuration/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "view-relayers",
    "behaviors": [
      "Filter by start and end date and time",
      "Show the username, domain, success flag and data volume",
      "Clicking a row opens the delivery reports filtered to that user"
    ],
    "acceptance": "A user who relayed 3 messages to remote domains in the period appears with their totals, and clicking the row opens the delivery reports with that user's filter applied.",
    "source": "https://docs.cpanel.net/whm/email/view-relayers/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "view-sent-summary",
    "behaviors": [
      "Historical view: successful, deferred and failed counts plus data sent, per domain",
      "Current view: whether the domain is within its hourly send limit and its defer/fail limit",
      "Choose columns, search, and open the delivery reports for a sender"
    ],
    "acceptance": "A domain that has sent more than its hourly limit is flagged as over the limit in the current view.",
    "source": "https://docs.cpanel.net/whm/email/view-sent-summary/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "configuration-cluster",
    "behaviors": [
      "Add a secondary server by hostname, root-level user and API token",
      "Push update preferences to every member when the 'send to cluster' option is set",
      "Edit or remove members; a removed member keeps the settings it already received",
      "Only the master shows cluster membership"
    ],
    "acceptance": "Adding a member with a token that lacks full root privilege is rejected with INSUFFICIENT_PRIVILEGES. Saving update preferences with 'send to cluster' queues one push job per member.",
    "source": "https://docs.cpanel.net/whm/clusters/configuration-cluster/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "dns-cluster",
    "behaviors": [
      "Turn clustering on or off, with a failure threshold (default 10 failed commands) after which a member is disabled automatically and root is notified",
      "Add a member by host, user and API token, with a role: standalone, synchronize or write-only",
      "Resellers can run their own cluster when allowed",
      "Every member must use the same DNS backend when DNSSEC zones exist"
    ],
    "acceptance": "A member that fails 10 commands in a row is marked disabled and an admin notification is created. A write-only member pushes zones but never pulls them.",
    "source": "https://docs.cpanel.net/whm/clusters/dns-cluster/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "clustering",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "remote-access-key",
    "behaviors": [
      "Show the current key",
      "Regenerate it, which makes the old key invalid"
    ],
    "acceptance": "After regeneration, a request signed with the old key returns UNAUTHORIZED.",
    "source": "https://docs.cpanel.net/whm/clusters/remote-access-key/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "panel-branding",
    "behaviors": [
      "Upload SVG logos for light and dark backgrounds, each with alt text",
      "Set the main menu color by picker or hex value, or reset it to the default",
      "Upload an .ico favicon and set where the help and documentation links point",
      "Set the public company name and contact URL shown on placeholder and suspended pages"
    ],
    "acceptance": "Uploading a PNG as a logo is rejected with UNSUPPORTED_FORMAT. A reseller's branding applies only to accounts that reseller owns.",
    "source": "https://docs.cpanel.net/whm/cpanel/customization/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "panel-change-log",
    "behaviors": [
      "List changes grouped by version",
      "Highlight the installed version"
    ],
    "acceptance": "The entry marked as installed matches the version the running panel reports.",
    "source": "https://docs.cpanel.net/whm/cpanel/change-log/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "site-software-catalog",
    "behaviors": [
      "Add or remove applications from the catalog",
      "Set the update policy for installed copies"
    ],
    "acceptance": "An application removed from the catalog no longer appears in the user's Site Software list, and the user install call returns NOT_AVAILABLE.",
    "source": "https://docs.cpanel.net/whm/cpanel/install-cpaddons-site-software/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "site-software-instances",
    "behaviors": [
      "List installations by account, domain and path",
      "Upgrade or uninstall an installation"
    ],
    "acceptance": "After a user installs an application, it appears in this list with its account and path. Uninstalling it here removes it from the user's view too.",
    "source": "https://docs.cpanel.net/whm/cpanel/manage-cpaddons-site-software/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "panel-news",
    "behaviors": [
      "Global news shown to every user",
      "Reseller news shown only to that reseller's customers",
      "Clear or update each message"
    ],
    "acceptance": "News set by reseller R appears only for accounts owned by R. Global news appears for every account.",
    "source": "https://docs.cpanel.net/whm/cpanel/modify-cpanel-whm-news/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "news",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "mailing-list-password-reset",
    "behaviors": [
      "Select a list",
      "Set a new password"
    ],
    "acceptance": "After the reset, the list admin login works with the new password and fails with the old one.",
    "source": "https://docs.cpanel.net/whm/cpanel/reset-a-mailman-password/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "theme-manager",
    "behaviors": [
      "Upload a theme package for each surface",
      "Preview, clone under a new name, download or delete a theme",
      "Reject a package that is missing the required password-change pages"
    ],
    "acceptance": "A package without the password-change templates is rejected with MISSING_REQUIRED_TEMPLATE. Cloning theme A as B creates B with identical files.",
    "source": "https://docs.cpanel.net/whm/themes/theme-manager/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "application-locales",
    "behaviors": [
      "Turn each locale on or off for each application"
    ],
    "acceptance": "Turning Arabic off for webmail removes it from the webmail language picker, while the user panel still offers it.",
    "source": "https://docs.cpanel.net/whm/locales/configure-application-locales/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "locale-list",
    "behaviors": [
      "Show each locale's code, name and whether it is right-to-left or left-to-right"
    ],
    "acceptance": "The list includes 'ar' with direction RTL.",
    "source": "https://docs.cpanel.net/whm/locales/view-available-locales/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "locale-copy",
    "behaviors": [
      "Choose the source locale and the new code"
    ],
    "acceptance": "Copying to an existing code returns CONFLICT. A successful copy has the same number of strings as its source.",
    "source": "https://docs.cpanel.net/whm/locales/copy-a-locale/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "locale-edit",
    "behaviors": [
      "Search strings by key or text",
      "Save a custom translation or go back to the shipped one"
    ],
    "acceptance": "After a string is overridden, the interface shows the new text. Reverting brings back the original.",
    "source": "https://docs.cpanel.net/whm/locales/edit-a-locale/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "locale-edit",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "locale-delete",
    "behaviors": [
      "Delete custom locales",
      "Refuse to delete the default locale"
    ],
    "acceptance": "Deleting the default locale is rejected with PROTECTED_LOCALE. Users who had the deleted locale fall back to the default.",
    "source": "https://docs.cpanel.net/whm/locales/delete-a-locale/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "locale-xml-export",
    "behaviors": [
      "Choose the locale and download the file"
    ],
    "acceptance": "Re-importing an exported file without changes leaves every string as it was.",
    "source": "https://docs.cpanel.net/whm/locales/locale-xml-download/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "locale-xml-import",
    "behaviors": [
      "Validate the file format before applying it",
      "Create or merge the locale"
    ],
    "acceptance": "A malformed XML file is rejected with INVALID_FORMAT and the existing locale is unchanged.",
    "source": "https://docs.cpanel.net/whm/locales/locale-xml-upload/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "process-manager",
    "behaviors": [
      "Show the PID, owner, priority, CPU %, memory % and command of each process",
      "Kill a single process or trace it",
      "Kill every process that belongs to a chosen user"
    ],
    "acceptance": "'Kill all for user X' leaves no process owned by X. Choosing root or a system account is rejected with PROTECTED_USER.",
    "source": "https://docs.cpanel.net/whm/system-health/process-manager/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "running-processes",
        "name": "Running Processes Snapshot",
        "source": "https://docs.cpanel.net/whm/system-health/show-current-running-processes/",
        "behaviors": [
          "Show the full process tree with owner and command"
        ]
      }
    ]
  },
  {
    "id": "background-process-killer",
    "behaviors": [
      "A checklist of forbidden process names",
      "A list of trusted users who are exempt (system UIDs are always exempt)",
      "Run during nightly maintenance and email a report"
    ],
    "acceptance": "During maintenance, a forbidden process owned by an untrusted user is killed, while the same process owned by a trusted user keeps running.",
    "source": "https://docs.cpanel.net/whm/system-health/background-process-killer/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "current-disk-usage",
    "behaviors": [
      "Show filesystem, mount point, size, used, available and percentage",
      "Show device I/O figures"
    ],
    "acceptance": "The used and available values for each mount match the OS statvfs figures to within 1%.",
    "source": "https://docs.cpanel.net/whm/system-health/show-current-disk-usage/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "system-reboot",
    "behaviors": [
      "Graceful reboot that stops services cleanly first",
      "Forceful reboot that ignores errors, for use only when graceful fails",
      "Can be denied to resellers"
    ],
    "acceptance": "A reseller without root access gets FORBIDDEN. A forceful reboot without an explicit confirmation flag is rejected with CONFIRMATION_REQUIRED.",
    "source": "https://docs.cpanel.net/whm/system-reboot/system-reboot/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "reboot",
    "absorbed": []
  },
  {
    "id": "antivirus-scanner-config",
    "behaviors": [
      "Global toggles: whole home directory, mail folders, public FTP area, public web area",
      "Per-user overrides for users added to the configured-users list",
      "Defaults for newly configured users; inbound mail is scanned at SMTP"
    ],
    "acceptance": "If one user's override turns mail scanning off while it stays on globally, a scan for that user skips mail folders and still scans them for other users.",
    "source": "https://docs.cpanel.net/whm/plugins/configure-clamav-scanner/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "comet-backup",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built. The xWHM plugin list does not include it.",
    "source": "https://docs.cpanel.net/whm/plugins/comet-backup/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "server-monitoring-360",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built.",
    "source": "https://docs.cpanel.net/whm/plugins/server-monitoring/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "webpros-dashboard",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built.",
    "source": "https://docs.cpanel.net/whm/plugins/webpros-dashboard/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "market-provider-manager",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built.",
    "source": "https://docs.cpanel.net/whm/market/market-provider-manager/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "support-center",
    "behaviors": [
      "Show the provider's documentation, forum and ticket links from configuration",
      "Hide any card that has no URL set"
    ],
    "acceptance": "A card with an empty URL in the provider configuration is not shown. Each shown link opens the configured URL.",
    "source": "https://docs.cpanel.net/whm/support/support-center/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "create-support-ticket",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built.",
    "source": "https://docs.cpanel.net/whm/support/create-support-ticket/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "grant-support-access",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built.",
    "source": "https://docs.cpanel.net/whm/support/grant-cpanel-support-access/",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-nodejs-versions",
    "behaviors": [
      "List releases with their LTS flag and npm and V8 versions, and refresh the list",
      "Install or uninstall a version and set the package registry mirror",
      "Install, upgrade or remove global modules and project modules, and set environment variables"
    ],
    "acceptance": "Uninstalling a version that a project still uses is rejected with IN_USE.",
    "source": "https://www.aapanel.com/docs/Function/Node.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-go-project",
    "behaviors": [
      "Fields: executable, name, port, an 'open firewall port' toggle, start command and run user",
      "Bind a domain and map it to ports 80 and 443, and deploy SSL",
      "View the runtime log; deploying from source is not supported"
    ],
    "acceptance": "Choosing a file without execute permission is rejected with NOT_EXECUTABLE. Turning on 'open firewall port' adds an allow rule for that port.",
    "source": "https://www.aapanel.com/docs/Function/go.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-go-sdk",
    "behaviors": [
      "Choose a version from the full list and install it",
      "Show the install log when installation fails"
    ],
    "acceptance": "After installing version V, running 'go version' in the terminal reports V.",
    "source": "https://www.aapanel.com/docs/Function/go.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-python-versions",
    "behaviors": [
      "Install interpreter versions",
      "Create a virtual environment from a chosen version under a name"
    ],
    "acceptance": "Creating an environment with a name that already exists is rejected with CONFLICT.",
    "source": "https://www.aapanel.com/docs/Function/python.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-java-project",
    "behaviors": [
      "Project manager with start, stop and logs",
      "JDK version manager",
      "Edit the service configuration file"
    ],
    "acceptance": "A project configured with a JDK that is not installed is rejected with RUNTIME_MISSING.",
    "source": "https://www.aapanel.com/docs/Function/Plug-ins.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-dashboard",
    "behaviors": [
      "Load, CPU, RAM and disk gauges, where hovering lists the top 5 processes",
      "Counts of sites, FTP accounts and databases that link to their pages",
      "Live network traffic with a NIC selector, and disk I/O with a disk selector",
      "Widgets for apps that are pinned to the dashboard"
    ],
    "acceptance": "Hovering the CPU gauge lists exactly 5 processes sorted by CPU, highest first. Creating a site raises the site counter by one.",
    "source": "https://www.aapanel.com/docs/Function/Home.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-task-messages",
    "behaviors": [
      "Task list with live progress",
      "Message history of operations",
      "Execution log for failed installs"
    ],
    "acceptance": "A failed install shows as failed and its execution log is readable from the message box.",
    "source": "https://www.aapanel.com/docs/Function/Home.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-language-theme",
    "behaviors": [
      "Language switcher",
      "Auto, light or dark theme"
    ],
    "acceptance": "Choosing dark mode persists across reloads. Auto mode follows the OS preference.",
    "source": "https://www.aapanel.com/docs/Function/Home.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-ftp-logs",
    "behaviors": [
      "Login log and action log for each account",
      "Risk scan across the FTP logs"
    ],
    "acceptance": "A failed login attempt appears in that account's login log with the source IP.",
    "source": "https://www.aapanel.com/docs/Function/Ftp.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-db-quota",
    "behaviors": [
      "View the current size against the limit",
      "Set the limit"
    ],
    "acceptance": "When a database goes over its limit, its user loses write permission until the size drops back under the limit.",
    "source": "https://www.aapanel.com/docs/Function/MySQL.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-phpmyadmin-access",
    "behaviors": [
      "Allow or deny public access (localhost only when denied)",
      "HTTP and HTTPS ports and an extra password layer",
      "Password-free login from the panel, and the PHP version it runs on"
    ],
    "acceptance": "With public access turned off, a request to the client from a non-local IP returns 403.",
    "source": "https://www.aapanel.com/docs/Function/MySQL.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-mysql-service",
    "behaviors": [
      "Start or stop it, with an optional alert when it stops; edit the configuration file",
      "Change the data directory, port and SSL settings",
      "Show live status with tuning tips; read the error log and slow log; manage binary logs",
      "Out-of-memory protection that must be applied again after each restart"
    ],
    "acceptance": "After the port changes to 3307, the daemon listens on 3307 and the panel's own connections still work.",
    "source": "https://www.aapanel.com/docs/Function/Deployment.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-sqlserver-remote",
    "behaviors": [
      "Add a remote server, then create databases with users on it",
      "Sync the inventory in both directions; change passwords in bulk; delete"
    ],
    "acceptance": "Creating a database with no remote server registered is rejected with NO_TARGET_SERVER.",
    "source": "https://www.aapanel.com/docs/Function/SQLServer.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-mongodb",
    "behaviors": [
      "Add a database with a user on the local or a remote server",
      "Authentication toggle and remote access setting",
      "Backup, restore, import and bulk actions"
    ],
    "acceptance": "With authentication on, an unauthenticated client cannot list databases.",
    "source": "https://www.aapanel.com/docs/Function/MongoDB.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-redis-keys",
    "behaviors": [
      "Database selector 0 to 15, with key, value, type, length and expiry columns",
      "Add or edit a key with a time-to-live",
      "Delete a key, or clear one database or all of them"
    ],
    "acceptance": "A key added with a 60-second TTL is no longer listed after 61 seconds.",
    "source": "https://www.aapanel.com/docs/Function/Redis.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-redis-service",
    "behaviors": [
      "Start or stop it, switch versions, edit the configuration",
      "Tuning: password, maxmemory and maxclients",
      "Persistence mode, remote access toggle, and backups with restore"
    ],
    "acceptance": "After a password is set, an unauthenticated command returns an authentication error.",
    "source": "https://www.aapanel.com/docs/Function/Deployment.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-postgresql-service",
    "behaviors": [
      "Service status and version management",
      "Edit the client authentication rules and the configuration file",
      "Storage location, port, performance tuning, log and slow log"
    ],
    "acceptance": "A client-auth rule that rejects a given IP blocks connections from that IP after a reload.",
    "source": "https://www.aapanel.com/docs/Function/Plug-ins.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-docker-apps",
    "behaviors": [
      "Install with version, domain proxy, bind address (loopback or all), host port, database credentials, and CPU and memory limits",
      "Update the catalog",
      "For installed apps: backup and restore, stop or restart, rebuild, uninstall, logs, open the install directory"
    ],
    "acceptance": "An app installed with bind address 127.0.0.1 cannot be reached on the public IP. Using a host port that is already taken is rejected with PORT_IN_USE.",
    "source": "https://www.aapanel.com/docs/Function/Docker.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-docker-overview",
    "behaviors": [
      "Server totals",
      "CPU, memory and network per container"
    ],
    "acceptance": "A stopped container shows zero CPU use.",
    "source": "https://www.aapanel.com/docs/Function/Docker.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-docker-containers",
    "behaviors": [
      "Create from an image form (ports, restart policy, network, mounts, command, entrypoint, privileged, limits, env), from a run-style command, or from a compose template",
      "Start, stop, restart, kill, pause, rename, delete, and remove all stopped containers",
      "Log rotation and log filtering by date range"
    ],
    "acceptance": "'Remove stopped containers' deletes every exited container and leaves running ones alone.",
    "source": "https://www.aapanel.com/docs/Function/Docker.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-docker-container-detail",
    "behaviors": [
      "Inspect data, IPs and ports; live logs",
      "A terminal (bash or sh, optionally as root)",
      "View mounts, join or leave networks, set the restart policy",
      "Save the container as an image, or proxy a mapped port through a site"
    ],
    "acceptance": "Setting the restart policy to 'always' makes the container start again after the daemon restarts.",
    "source": "https://www.aapanel.com/docs/Function/Docker.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-docker-images",
    "behaviors": [
      "Search the hub and pull images",
      "Import a file, build from a path or pasted build file, push, export",
      "Delete images and remove unused ones"
    ],
    "acceptance": "Deleting an image that a container is using is rejected with IN_USE.",
    "source": "https://www.aapanel.com/docs/Function/Docker.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-docker-compose",
    "behaviors": [
      "Add a stack with a name, compose YAML, env content and notes, and optionally save it as a template",
      "Start, stop, restart or update the images of a stack, delete it, read its combined logs, edit its YAML and env",
      "Template library: add, edit, pull images, delete, search"
    ],
    "acceptance": "Invalid YAML is rejected with VALIDATION_ERROR before anything is created.",
    "source": "https://www.aapanel.com/docs/Function/Docker.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-docker-networks",
    "behaviors": [
      "Driver, IPv4 subnet, gateway and range, optional IPv6, labels",
      "Delete networks and remove unused ones"
    ],
    "acceptance": "A subnet that overlaps an existing network is rejected with CONFLICT.",
    "source": "https://www.aapanel.com/docs/Function/Docker.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-docker-volumes",
    "behaviors": [
      "Add with name, options and labels",
      "Delete volumes and remove unused ones"
    ],
    "acceptance": "Removing unused volumes leaves every volume that is mounted by a container.",
    "source": "https://www.aapanel.com/docs/Function/Docker.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-docker-registries",
    "behaviors": [
      "Add, edit or delete a registry with URL, user, password and namespace"
    ],
    "acceptance": "Adding a registry with wrong credentials is rejected with AUTH_FAILED.",
    "source": "https://www.aapanel.com/docs/Function/Docker.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-docker-settings",
    "behaviors": [
      "Start, stop, restart or repair the daemon",
      "Pull mirror URL, compose path, daemon config path and IPv6 toggle",
      "Uninstall the engine"
    ],
    "acceptance": "After a mirror URL is set and the daemon restarts, pulls go through the mirror.",
    "source": "https://www.aapanel.com/docs/Function/Docker.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-system-monitor",
    "behaviors": [
      "Turn monitoring on or off, set the retention days, show how much space the data uses",
      "Charts for yesterday, today, the last 7 days or a custom range",
      "Hovering a point lists the top 5 processes with CPU, memory, I/O and network figures",
      "Clear all monitoring data"
    ],
    "acceptance": "With retention set to 7 days, data points older than 7 days are purged. Clearing the data empties every chart.",
    "source": "https://www.aapanel.com/docs/Function/Monitor.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-mail-bcc",
    "behaviors": [
      "A rule with direction, source, target and an on/off toggle"
    ],
    "acceptance": "With an outbound BCC rule on, every message the source sends also arrives at the target.",
    "source": "https://www.aapanel.com/docs/Function/MailServer.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-mail-campaigns",
    "behaviors": [
      "Task fields: sender, display name, subject, recipient group, template, unsubscribe link, threads, schedule, test send",
      "Template editor (drag-and-drop or HTML) with import, export, duplicate and preview",
      "Success and failure counts and error logs for each task"
    ],
    "acceptance": "A campaign that includes an unsubscribe link puts a working link in every message, and a recipient who uses it is excluded from later sends to that group.",
    "source": "https://www.aapanel.com/docs/Function/MailServer.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-mail-subscribers",
    "behaviors": [
      "Import subscribers from text or JSON; move them between groups; set subscribe status",
      "Groups with counts",
      "Suspend list: scan for invalid domains, auto-block failing addresses, remove addresses to retry"
    ],
    "acceptance": "An address on the suspend list is skipped by later campaigns until it is removed from the list.",
    "source": "https://www.aapanel.com/docs/Function/MailServer.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-mail-automation",
    "behaviors": [
      "Steps: send mail, delay, webhook",
      "Sent, delivered, opened and clicked counters",
      "Duplicate, rename, edit, delete"
    ],
    "acceptance": "A new subscriber added to the trigger group receives the first step's message after the configured delay.",
    "source": "https://www.aapanel.com/docs/Function/MailServer.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-anti-spam-gateway",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built. Spam filtering is provided by the mail server's filter.",
    "source": "https://www.aapanel.com/docs/Function/Plug-ins.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-file-share",
    "behaviors": [
      "Create a share, optionally with an expiry or a code",
      "List and revoke shares"
    ],
    "acceptance": "A revoked share link returns 404, and an expired link returns 410.",
    "source": "https://www.aapanel.com/docs/Function/Files.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-log-security-analysis",
    "behaviors": [
      "Choose a site and run the analysis",
      "Report findings grouped by type with counts and sample requests"
    ],
    "acceptance": "A fixture log with 3 SQL-injection requests gives a report with 3 findings of type SQL injection.",
    "source": "https://www.aapanel.com/docs/Function/Logs.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-os-log-audit",
    "behaviors": [
      "Browse the system logs by category",
      "Search and filter by time"
    ],
    "acceptance": "An auth event written to the system log appears in the audit view within one refresh.",
    "source": "https://www.aapanel.com/docs/Function/Logs.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-software-logs",
    "behaviors": [
      "FTP logins and operations",
      "Slow SQL statements",
      "Database runtime errors"
    ],
    "acceptance": "A query slower than the slow-log threshold appears in the slow log view.",
    "source": "https://www.aapanel.com/docs/Function/Logs.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-node-management",
    "behaviors": [
      "Add a node by API key (panel address, key, category) or by SSH (IP, port, password or key), with a connection test",
      "Probe mode for live CPU and memory figures; online or offline status; list or grid view",
      "Open the remote panel, edit, delete, restart the remote panel, reboot the remote OS"
    ],
    "acceptance": "A node whose API key is wrong fails the connection test with AUTH_FAILED and is not saved.",
    "source": "https://www.aapanel.com/docs/Function/panel-node.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-node-file-transfer",
    "behaviors": [
      "A source pane and a target pane, each with path navigation",
      "Send files to the local node or the remote node",
      "Only nodes linked by API key are supported"
    ],
    "acceptance": "Trying to transfer to a node added over SSH is rejected with UNSUPPORTED_NODE_TYPE.",
    "source": "https://www.aapanel.com/docs/Function/panel-node.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-dns-provider-accounts",
    "behaviors": [
      "Add a provider with status, API user, key or token, alias and permission scope",
      "List providers with their domain counts; edit, delete"
    ],
    "acceptance": "Credentials the provider rejects are refused with AUTH_FAILED. A scope limited to read-only blocks record writes with FORBIDDEN.",
    "source": "https://www.aapanel.com/docs/Function/Domains.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-provider-domains",
    "behaviors": [
      "Pull the latest data and view the pull log",
      "Record count, certificate days left and expiry for each domain"
    ],
    "acceptance": "After a pull, a domain added at the provider appears in the list.",
    "source": "https://www.aapanel.com/docs/Function/Domains.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-provider-dns-records",
    "behaviors": [
      "Types A, AAAA, CNAME, TXT and MX, with TTL and remark",
      "Proxy flag where the provider supports it"
    ],
    "acceptance": "A record created here can be read back from the provider's API with the same value and TTL.",
    "source": "https://www.aapanel.com/docs/Function/Domains.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-auto-dns-on-site-create",
    "behaviors": [
      "An 'add record automatically' option in the create-site form",
      "Check the server IP before writing the record"
    ],
    "acceptance": "Creating a site with the option on and a working provider creates an A record that points to the server IP.",
    "source": "https://www.aapanel.com/docs/Function/Domains.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-ddns",
    "behaviors": [
      "Select a hostname and provider credentials",
      "Check the IP on a schedule and update the record when it changes"
    ],
    "acceptance": "When the detected public IP changes, the record is updated on the next check.",
    "source": "https://www.aapanel.com/docs/Function/Plug-ins.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-subpanel-service",
    "behaviors": [
      "Stop, restart, reload",
      "Certificate content",
      "The domain or IP that serves the sub-panel"
    ],
    "acceptance": "After the host changes, the sub-panel answers on the new host name.",
    "source": "https://www.aapanel.com/docs/Function/Account.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-web-terminal",
    "behaviors": [
      "Connect to the local server by default",
      "Add a remote host with IP or domain, port, user, and a password or private key with passphrase, plus notes",
      "Warn before running commands that would stop the panel itself"
    ],
    "acceptance": "A remote host saved with a wrong key fails to connect with AUTH_FAILED, and stored secrets are never returned in API reads.",
    "source": "https://www.aapanel.com/docs/Function/Terminal.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-saved-commands",
    "behaviors": [
      "Add, edit and delete commands, each with a name and content",
      "Send a command to the active session"
    ],
    "acceptance": "Clicking a saved command types its content into the active session exactly once.",
    "source": "https://www.aapanel.com/docs/Function/Terminal.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-cron-tasks",
    "behaviors": [
      "Types: shell script, site backup, database backup, log rotation, directory backup, time sync, memory release, URL request",
      "Cycles: daily, every N days, hourly, every N hours, every N minutes, weekly, monthly, every N seconds (not offered for backup types)",
      "Backup jobs keep the latest N copies, support exclusion rules and alert on failure",
      "Run now, view and clear logs, enable or disable, edit, delete"
    ],
    "acceptance": "Creating a site-backup task with an every-N-seconds cycle is rejected with VALIDATION_ERROR. With retention 3, a fourth backup run deletes the oldest copy.",
    "source": "https://www.aapanel.com/docs/Function/Cron.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-task-chaining",
    "behaviors": [
      "Name, cycle, command or library script, remark",
      "Run, edit, log, delete"
    ],
    "acceptance": "A chained task records its output in its log and makes that output available to its triggers.",
    "source": "https://www.aapanel.com/docs/Function/Cron.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-event-triggers",
    "behaviors": [
      "Match types: include, exclude, equal, not equal",
      "Edit, view the log, delete"
    ],
    "acceptance": "A trigger set to 'include stopped' fires when the task output contains 'stopped' and does not fire otherwise.",
    "source": "https://www.aapanel.com/docs/Function/Cron.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-script-library",
    "behaviors": [
      "Name, type, return type (float, string or integer), arguments, remark",
      "Run, edit, log, delete"
    ],
    "acceptance": "A script declared to return an integer that outputs text is flagged with a TYPE_MISMATCH result in its log.",
    "source": "https://www.aapanel.com/docs/Function/Cron.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-app-catalog",
    "behaviors": [
      "Search and filter by all, installed, deployment, tools, plugins or professional; refresh the list; recently used",
      "Show developer, description, install location and running status for each item",
      "Toggle whether an item appears on the dashboard, and view install logs"
    ],
    "acceptance": "Installing a package changes its status to installed, and a failed install leaves a readable log with a failed status.",
    "source": "https://www.aapanel.com/docs/Function/AppStore.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "server-plugins",
        "name": "Server Plugins",
        "source": "https://docs.cpanel.net/whm/cpanel/manage-plugins/",
        "behaviors": [
          "List available plugins with an install or uninstall action",
          "Show install progress",
          "Hide this page on DNS-only servers and when the reseller lacks permission"
        ]
      },
      {
        "id": "aapanel-ffmpeg",
        "name": "Media Toolkit Installer",
        "source": "https://www.aapanel.com/docs/Function/Plug-ins.html",
        "behaviors": [
          "Install or uninstall"
        ]
      }
    ]
  },
  {
    "id": "aapanel-third-party-plugin-import",
    "behaviors": [
      "Upload a package",
      "Validate it and install it"
    ],
    "acceptance": "A package with a missing or invalid manifest is rejected with INVALID_PACKAGE.",
    "source": "https://www.aapanel.com/docs/Function/AppStore.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-openlitespeed-manager",
    "behaviors": [
      "Service control",
      "Configuration files",
      "Tuning"
    ],
    "acceptance": "Stopping the service changes its status to stopped, and sites served by it stop responding.",
    "source": "https://www.aapanel.com/docs/Function/Deployment.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-memcached-manager",
    "behaviors": [
      "Service control and version switch",
      "Configuration and tuning such as memory size and connections",
      "Load view"
    ],
    "acceptance": "Changing the memory size takes effect after a restart and is shown in the stats.",
    "source": "https://www.aapanel.com/docs/Function/Deployment.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-elasticsearch-manager",
    "behaviors": [
      "Service status",
      "Access permissions, configuration, config file, logs"
    ],
    "acceptance": "With access restricted to localhost, the HTTP port refuses external connections.",
    "source": "https://www.aapanel.com/docs/Function/Deployment.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-rabbitmq-manager",
    "behaviors": [
      "Service status",
      "Admin credentials",
      "Logs"
    ],
    "acceptance": "After the admin password changes, the broker admin login refuses the old password.",
    "source": "https://www.aapanel.com/docs/Function/Deployment.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-mongodb-service",
    "behaviors": [
      "Service status and configuration items",
      "Config file and log"
    ],
    "acceptance": "A configuration change to the bind address takes effect after a restart.",
    "source": "https://www.aapanel.com/docs/Function/Deployment.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-clamav",
    "behaviors": [
      "On-demand or scheduled scans of chosen paths",
      "Quarantine with restore or delete",
      "A whitelist of excluded paths"
    ],
    "acceptance": "A test-signature file is detected and moved to quarantine, and a whitelisted path is skipped.",
    "source": "https://www.aapanel.com/docs/Function/Tools.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-frp-manager",
    "behaviors": [
      "Server: status, service settings, config file, log",
      "Client: config file, log"
    ],
    "acceptance": "A client configuration with a valid token connects, and the tunnel's port answers on the server.",
    "source": "https://www.aapanel.com/docs/Function/Tools.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-boot-items",
    "behaviors": [
      "Startup items list",
      "System services: enable, disable, start, stop",
      "Edit environment variables"
    ],
    "acceptance": "A service disabled here does not start after a reboot.",
    "source": "https://www.aapanel.com/docs/Function/Tools.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-performance-test",
    "behaviors": [
      "System info and current load",
      "One-click overall test",
      "Disk throughput, IOPS and latency tests (sequential, random, mixed); network speed tests compared across nodes"
    ],
    "acceptance": "A disk test on a chosen partition stores a result with throughput, IOPS and latency, and the result is listed in the history.",
    "source": "https://www.aapanel.com/docs/Function/Tools.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-linux-tools",
    "behaviors": [
      "Set resolver servers and time zone",
      "Create or resize swap, and create a RAM disk (lost on reboot)",
      "Change a system user's password and edit the hosts file",
      "Install or remove common diagnostic tools"
    ],
    "acceptance": "Setting a 1 GB swap makes the OS report 1 GB of swap. A hosts entry resolves locally right away.",
    "source": "https://www.aapanel.com/docs/Function/Tools.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-supervisor",
    "behaviors": [
      "Daemon list with start, stop and restart",
      "Edit the master profile",
      "Supervisor service status and log"
    ],
    "acceptance": "A supervised daemon that is killed is started again automatically within its restart policy.",
    "source": "https://www.aapanel.com/docs/Function/Tools.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-log-cleanup",
    "behaviors": [
      "Choose log categories",
      "Show how much space would be freed, then delete"
    ],
    "acceptance": "The space reported as freed matches the drop in disk usage, to within 1%.",
    "source": "https://www.aapanel.com/docs/Function/Tools.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "aapanel-site-log-usage",
        "name": "Website Log Usage",
        "source": "https://www.aapanel.com/docs/Function/Security.html",
        "behaviors": [
          "Displays path and size",
          "Clear truncates logs after confirmation without restarting the web server"
        ]
      }
    ]
  },
  {
    "id": "aapanel-webhook",
    "behaviors": [
      "Create a hook with a script",
      "Generated URL with an access key",
      "Call log"
    ],
    "acceptance": "A call with a wrong key returns 403 and runs nothing. A call with the right key runs the script once and logs it.",
    "source": "https://www.aapanel.com/docs/Function/Plug-ins.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-php-guardian",
    "behaviors": [
      "Background health checks",
      "Restart pools that hang"
    ],
    "acceptance": "A pool that stops answering its status endpoint is restarted within one check interval.",
    "source": "https://www.aapanel.com/docs/Function/Plug-ins.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-panel-general",
    "behaviors": [
      "Toggles for IPv6, offline mode (no outbound calls), real IP behind a CDN, site monitor, automatic favicon fetch, automatic panel backup, developer mode",
      "Alias in the page title, idle logout after N hours, hidden menu bar",
      "Default site and backup folders; server IP as shown; view and sync server time"
    ],
    "acceptance": "With an idle timeout of 1 hour, a session with no activity for 61 minutes is logged out. In offline mode, no outbound HTTP requests are made.",
    "source": "https://www.aapanel.com/docs/Function/Settings.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": [
      {
        "id": "aapanel-panel-runtime",
        "name": "Panel Runtime Options",
        "source": "https://www.aapanel.com/docs/Function/Settings.html",
        "behaviors": [
          "Close panel: UI stops, sites and databases keep running",
          "Listen on IPv6",
          "Offline mode disables internet-dependent features",
          "Read real client IP from a CDN for the panel",
          "Developer mode raises a security alert",
          "Panel alias for page titles",
          "Default site and backup folders"
        ]
      }
    ]
  },
  {
    "id": "aapanel-panel-backup-restore",
    "behaviors": [
      "Create a backup of the chosen data",
      "Upload a backup file or place it in the restore folder",
      "Download, restore (with 'overwrite items that have the same name'), delete; details and logs"
    ],
    "acceptance": "Restoring without 'overwrite' set leaves existing items with the same name unchanged and reports them as skipped.",
    "source": "https://www.aapanel.com/docs/Function/Settings.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-server-migrate",
    "behaviors": [
      "Target server credentials",
      "Back up, transfer and restore",
      "Report software that must be reinstalled by hand"
    ],
    "acceptance": "After migration to a fresh host, every site and database on the source exists on the target, and the report lists any extensions it skipped.",
    "source": "https://www.aapanel.com/docs/Function/Settings.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-ai-assistant",
    "behaviors": [
      "Chat with history, model choice and file upload",
      "Diagnostic assistants for logs, files, network, databases, performance, security and services",
      "Skill packs, custom model endpoints, and quota tracking with purchasable packages"
    ],
    "acceptance": "Not built in this phase.",
    "source": "https://www.aapanel.com/docs/Function/ai.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-ai-chatops",
    "behaviors": [
      "Bot token, model, allowlisted chat or channel IDs, high-risk toggle"
    ],
    "acceptance": "Not built in this phase.",
    "source": "https://www.aapanel.com/docs/Function/ai.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-php-code-security",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built.",
    "source": "https://www.aapanel.com/docs/Function/Professional.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-file-monitor",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built.",
    "source": "https://www.aapanel.com/docs/Function/Professional.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-abnormal-push",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built. Basic alerting is covered by the existing alarm tasks.",
    "source": "https://www.aapanel.com/docs/Function/Professional.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-website-analytics",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built.",
    "source": "https://www.aapanel.com/docs/Function/Professional.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-task-manager",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built here. Process control is covered by the xWHM process manager.",
    "source": "https://www.aapanel.com/docs/Function/Professional.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-disk-analysis",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built.",
    "source": "https://www.aapanel.com/docs/Function/Professional.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-platform-ops",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built.",
    "source": "https://www.aapanel.com/docs/Function/Professional.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-panel-user-manager",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built. Delegated admins are covered by reseller ACLs in xWHM.",
    "source": "https://www.aapanel.com/docs/Function/Professional.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-mobile-app",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built.",
    "source": "https://www.aapanel.com/docs/Function/Professional.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-load-balance",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built.",
    "source": "https://www.aapanel.com/docs/Function/Tutorial/Load_balance.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-files-sync",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built.",
    "source": "https://www.aapanel.com/docs/Function/Tutorial/files_sync.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-nfs-manager",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built.",
    "source": "https://www.aapanel.com/docs/Function/Professional.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  },
  {
    "id": "aapanel-license-voucher",
    "behaviors": [
      "Listed for coverage only"
    ],
    "acceptance": "Not built.",
    "source": "https://www.aapanel.com/docs/Function/Tutorial/deduct_coupons.html",
    "upstreamFeatureKey": "",
    "upstreamAcl": "",
    "upstreamApi": "",
    "absorbed": []
  }
]
