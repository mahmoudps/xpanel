import { msgid } from '@xpanel/core'

/**
 * One-click container apps. Each is a compose template with reviewed images, so an install is an ordinary stack.
 * The catalog ships with the panel: a new catalog arrives with a signed release, not from a network feed.
 */
export interface CtrApp { id: string; name: string; description: string; version: string; port: number; secrets: readonly string[]; yaml: string }
const single = (image: string, port: number, target: string): string => `services:
  app:
    image: ${image}:\${VERSION}
    restart: always
    ports:
      - "\${BIND}:\${HOST_PORT}:${port}"
    volumes:
      - ./data:${target}
`
export const CTR_APPS: readonly CtrApp[] = [
  { id: 'uptime-kuma', name: 'Uptime Kuma', description: msgid('Self-hosted uptime monitor with status pages.'), version: '1', port: 3001, secrets: [], yaml: single('docker.io/louislam/uptime-kuma', 3001, '/app/data') },
  { id: 'vaultwarden', name: 'Vaultwarden', description: msgid('Password manager server compatible with Bitwarden clients.'), version: '1.32.7', port: 80, secrets: [], yaml: single('docker.io/vaultwarden/server', 80, '/data') },
  { id: 'gitea', name: 'Gitea', description: msgid('Lightweight Git service with issues and pull requests.'), version: '1.22', port: 3000, secrets: [], yaml: single('docker.io/gitea/gitea', 3000, '/data') },
  { id: 'n8n', name: 'n8n', description: msgid('Workflow automation with a visual editor.'), version: '1.76.1', port: 5678, secrets: [], yaml: single('docker.io/n8nio/n8n', 5678, '/home/node/.n8n') },
  { id: 'adminer', name: 'Adminer', description: msgid('Database manager in a single page.'), version: '4', port: 8080, secrets: [], yaml: `services:
  app:
    image: docker.io/library/adminer:\${VERSION}
    restart: always
    ports:
      - "\${BIND}:\${HOST_PORT}:8080"
` },
  { id: 'wordpress', name: 'WordPress', description: msgid('Blog and website platform with its own MariaDB.'), version: '6', port: 80, secrets: ['DB_PASSWORD', 'DB_ROOT_PASSWORD'], yaml: `services:
  db:
    image: docker.io/library/mariadb:11
    restart: always
    environment:
      MARIADB_DATABASE: wordpress
      MARIADB_USER: wordpress
      MARIADB_PASSWORD: \${DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - ./database:/var/lib/mysql
  app:
    image: docker.io/library/wordpress:\${VERSION}
    restart: always
    depends_on: [db]
    environment:
      WORDPRESS_DB_HOST: 127.0.0.1
      WORDPRESS_DB_NAME: wordpress
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: \${DB_PASSWORD}
    ports:
      - "\${BIND}:\${HOST_PORT}:80"
    volumes:
      - ./html:/var/www/html
` },
]
