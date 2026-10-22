import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants, existsSync, realpathSync } from 'node:fs'
import { chmod, chown, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'

export const DEFAULT_AGENT_SOCKET_BACKLOG = 32
export const MAX_AGENT_SOCKET_CONNECTIONS = 64
export const MAX_AGENT_INFLIGHT_REQUESTS = 32
export const DEFAULT_AGENT_SOCKET_IDLE_TIMEOUT_MS = 35_000

export interface KernelPeerCredentials {
  readonly uid: number
  readonly gid: number
  readonly pid: number
}

export interface VerifiedRequestPeerContext {
  readonly peer: KernelPeerCredentials
  readonly allowedPeerUids: ReadonlySet<number>
  readonly credentialSource: 'SO_PEERCRED'
}

export interface PeerIdentityDecisionEvent {
  readonly allowed: boolean
  readonly peer: KernelPeerCredentials
  readonly allowedPeerUids: readonly number[]
  readonly credentialSource: 'SO_PEERCRED'
  readonly pathname: string
  readonly method: string
}

export interface NativePeerAcceptedConnection {
  readonly fd: number
  readonly uid: number
  readonly gid: number
  readonly pid: number
}

export interface NativePeerIdentityAddon {
  openListener(
    socketPath: string,
    gid: number,
    mode: number,
    backlog: number,
    onReadable: () => void,
  ): unknown
  acceptPeer(listener: unknown): NativePeerAcceptedConnection | null
  verifyListenerSocket(listener: unknown): boolean
  closeListener(listener: unknown): void
  closeFd(fd: number): void
  getSocketPeerCred(fd: number): KernelPeerCredentials
}

const verifiedRequestPeers = new WeakMap<Request, VerifiedRequestPeerContext>()

export const stripForgedPeerHeaders = (headers: Headers): void => {
  const toDelete: string[] = []
  headers.forEach((_value, key) => {
    const lower = key.toLowerCase()
    if (lower.startsWith('x-xpanel-peer') || lower === 'x-peer-uid' || lower === 'x-peer-pid' || lower === 'x-peer-gid') {
      toDelete.push(key)
    }
  })
  for (const key of toDelete) headers.delete(key)
}

export const assertValidKernelPeerCredentials = (peer: unknown): KernelPeerCredentials => {
  if (!peer || typeof peer !== 'object') {
    return fail('PRECONDITION_FAILED', 'kernel socket peer credentials are required')
  }
  const candidate = peer as Record<string, unknown>
  const { uid, gid, pid } = candidate
  if (
    typeof uid !== 'number' ||
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    typeof gid !== 'number' ||
    !Number.isSafeInteger(gid) ||
    gid < 0 ||
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 0
  ) {
    return fail('PRECONDITION_FAILED', 'kernel socket peer credentials contain invalid uid, gid or pid metadata')
  }
  return Object.freeze({ uid: uid as number, gid: gid as number, pid: pid as number })
}

export const normalizeAllowedPeerUids = (
  expectedPeerUid: number | readonly number[],
  allowRootPeer = false,
): ReadonlySet<number> => {
  const list = typeof expectedPeerUid === 'number' ? [expectedPeerUid] : [...expectedPeerUid]
  if (list.length === 0) {
    fail('PRECONDITION_FAILED', 'at least one expected peer UID must be configured')
  }
  const set = new Set<number>()
  for (const uid of list) {
    if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 0) {
      fail('PRECONDITION_FAILED', 'expected peer UID must be a non-negative safe integer')
    }
    set.add(uid)
  }
  if (allowRootPeer) set.add(0)
  return set
}

export const bindVerifiedRequestPeer = (
  request: Request,
  context: {
    peer: KernelPeerCredentials
    allowedPeerUids: ReadonlySet<number>
    credentialSource?: 'SO_PEERCRED'
  },
): Request => {
  const peer = assertValidKernelPeerCredentials(context.peer)
  if (!context.allowedPeerUids || context.allowedPeerUids.size === 0) {
    fail('PRECONDITION_FAILED', 'verified peer context requires a non-empty allowed UID set')
  }
  for (const uid of context.allowedPeerUids) {
    if (!Number.isSafeInteger(uid) || uid < 0) {
      fail('PRECONDITION_FAILED', 'verified peer context contains an invalid allowed UID')
    }
  }
  verifiedRequestPeers.set(
    request,
    Object.freeze({
      peer,
      allowedPeerUids: new Set(context.allowedPeerUids),
      credentialSource: context.credentialSource ?? 'SO_PEERCRED',
    }),
  )
  return request
}

export const getVerifiedRequestPeer = (request: Request): VerifiedRequestPeerContext | undefined =>
  verifiedRequestPeers.get(request)

export interface ResolveProvisionedPeerUidsOptions {
  gid: number
  expectedPeerUid?: number | readonly number[]
  allowRootPeer?: boolean
  etcGroupContent?: string
  etcPasswdContent?: string
}

const readRootProtectedSystemFile = async (path: string): Promise<string> => {
  if (process.platform !== 'linux' || !isAbsolute(path)) {
    fail('PRECONDITION_FAILED', 'system identity tables require an absolute Linux path')
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      fail('PRECONDITION_FAILED', `system identity file must be root-owned and non-writable: ${path}`)
    }
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Resolves the authorized peer UID set for the agent socket.
 * - If `expectedPeerUid` is explicitly provided, only those UID(s) are permitted
 *   (plus UID 0 only when `allowRootPeer: true`).
 * - Otherwise if `XPANEL_API_UID` is set, only that UID is permitted
 *   (plus UID 0 only when `allowRootPeer: true`).
 * - Otherwise resolves the unique non-root service user assigned to the dedicated
 *   `gid` socket group in `/etc/group` + `/etc/passwd`. Fails closed if zero or
 *   multiple non-root identities belong to the socket group.
 */
export const resolveProvisionedPeerUids = async (
  opts: ResolveProvisionedPeerUidsOptions,
): Promise<ReadonlySet<number>> => {
  if (!Number.isSafeInteger(opts.gid) || opts.gid <= 0) {
    fail('PRECONDITION_FAILED', 'agent socket requires a positive numeric dedicated group ID')
  }
  if (opts.expectedPeerUid !== undefined) {
    return normalizeAllowedPeerUids(opts.expectedPeerUid, opts.allowRootPeer === true)
  }
  const envApiUid = process.env.XPANEL_API_UID?.trim()
  if (envApiUid) {
    const parsed = Number(envApiUid)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      fail('PRECONDITION_FAILED', 'XPANEL_API_UID must be a positive safe integer')
    }
    return normalizeAllowedPeerUids(parsed, opts.allowRootPeer === true)
  }

  const [groupText, passwdText] = await Promise.all([
    opts.etcGroupContent !== undefined ? Promise.resolve(opts.etcGroupContent) : readRootProtectedSystemFile('/etc/group'),
    opts.etcPasswdContent !== undefined ? Promise.resolve(opts.etcPasswdContent) : readRootProtectedSystemFile('/etc/passwd'),
  ])

  const usersByName = new Map<string, { uid: number; gid: number }>()
  const primaryGroupUsers: number[] = []
  for (const rawLine of passwdText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(':')
    if (parts.length < 4) continue
    const username = parts[0]!
    const uid = Number(parts[2])
    const userGid = Number(parts[3])
    if (!username || !Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(userGid) || userGid < 0) continue
    usersByName.set(username, { uid, gid: userGid })
    if (userGid === opts.gid && uid !== 0) {
      primaryGroupUsers.push(uid)
    }
  }

  let matchedGroupMembers: string[] | null = null
  for (const rawLine of groupText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(':')
    if (parts.length < 4) continue
    const gid = Number(parts[2])
    if (gid !== opts.gid) continue
    matchedGroupMembers = parts[3]!
      .split(',')
      .map((member) => member.trim())
      .filter(Boolean)
    break
  }

  if (matchedGroupMembers === null) {
    return fail('PRECONDITION_FAILED', `dedicated agent socket group GID ${opts.gid} was not found in /etc/group`)
  }

  const candidateUids = new Set<number>(primaryGroupUsers)
  const members = matchedGroupMembers ?? []
  for (const member of members) {
    if (member === 'root') continue
    const user = usersByName.get(member)
    if (!user || user.uid <= 0) {
      fail('PRECONDITION_FAILED', `agent socket group member "${member}" does not resolve to an unprivileged UID`)
      continue
    }
    candidateUids.add(user.uid)
  }

  if (candidateUids.size === 0) {
    fail('PRECONDITION_FAILED', 'agent socket group does not contain a provisioned unprivileged API service identity')
  }
  if (candidateUids.size > 1) {
    fail('PRECONDITION_FAILED', 'agent socket group contains multiple non-root identities; explicit expectedPeerUid is required')
  }

  return normalizeAllowedPeerUids([...candidateUids], opts.allowRootPeer ?? true)
}

/**
 * Audited self-contained C11 N-API source for AF_UNIX socket ownership and
 * kernel SO_PEERCRED verification on Linux.
 */
export const PEER_IDENTITY_C_SOURCE = /* c */ `
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_ref__* napi_ref;
typedef struct napi_handle_scope__* napi_handle_scope;
typedef struct napi_callback_info__* napi_callback_info;
typedef void (*napi_finalize)(napi_env env, void* finalize_data, void* finalize_hint);
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

typedef enum {
  napi_ok = 0
} napi_status;

typedef enum {
  napi_default = 0
} napi_property_attributes;

typedef struct {
  const char* utf8name;
  napi_value name;
  napi_callback method;
  napi_callback getter;
  napi_callback setter;
  napi_value value;
  napi_property_attributes attributes;
  void* data;
} napi_property_descriptor;

typedef struct uv_loop_s uv_loop_t;
typedef struct uv_handle_s uv_handle_t;
typedef struct uv_poll_s {
  void* data;
  unsigned char _opaque[4088];
} uv_poll_t;

typedef void (*uv_poll_cb)(uv_poll_t* handle, int status, int events);
typedef void (*uv_close_cb)(uv_handle_t* handle);

enum {
  UV_READABLE = 1
};

extern napi_status napi_get_cb_info(
    napi_env env,
    napi_callback_info cbinfo,
    size_t* argc,
    napi_value* argv,
    napi_value* this_arg,
    void** data);
extern napi_status napi_throw_error(napi_env env, const char* code, const char* msg);
extern napi_status napi_get_undefined(napi_env env, napi_value* result);
extern napi_status napi_get_null(napi_env env, napi_value* result);
extern napi_status napi_get_global(napi_env env, napi_value* result);
extern napi_status napi_get_boolean(napi_env env, bool value, napi_value* result);
extern napi_status napi_create_object(napi_env env, napi_value* result);
extern napi_status napi_create_int32(napi_env env, int32_t value, napi_value* result);
extern napi_status napi_create_uint32(napi_env env, uint32_t value, napi_value* result);
extern napi_status napi_get_value_int32(napi_env env, napi_value value, int32_t* result);
extern napi_status napi_get_value_uint32(napi_env env, napi_value value, uint32_t* result);
extern napi_status napi_get_value_string_utf8(napi_env env, napi_value value, char* buf, size_t bufsize, size_t* result);
extern napi_status napi_set_named_property(napi_env env, napi_value object, const char* utf8name, napi_value value);
extern napi_status napi_define_properties(napi_env env, napi_value object, size_t property_count, const napi_property_descriptor* properties);
extern napi_status napi_create_external(napi_env env, void* data, napi_finalize finalize_cb, void* finalize_hint, napi_value* result);
extern napi_status napi_get_value_external(napi_env env, napi_value value, void** result);
extern napi_status napi_create_reference(napi_env env, napi_value value, uint32_t initial_refcount, napi_ref* result);
extern napi_status napi_delete_reference(napi_env env, napi_ref ref);
extern napi_status napi_get_reference_value(napi_env env, napi_ref ref, napi_value* result);
extern napi_status napi_open_handle_scope(napi_env env, napi_handle_scope* result);
extern napi_status napi_close_handle_scope(napi_env env, napi_handle_scope scope);
extern napi_status napi_call_function(napi_env env, napi_value recv, napi_value func, size_t argc, const napi_value* argv, napi_value* result);
extern napi_status napi_get_uv_event_loop(napi_env env, uv_loop_t** loop);

extern int uv_poll_init(uv_loop_t* loop, uv_poll_t* handle, int fd);
extern int uv_poll_start(uv_poll_t* handle, int events, uv_poll_cb cb);
extern int uv_poll_stop(uv_poll_t* handle);
extern void uv_close(uv_handle_t* handle, uv_close_cb close_cb);

typedef napi_value (*napi_addon_register_func)(napi_env env, napi_value exports);
typedef struct napi_module {
  int nm_version;
  unsigned int nm_flags;
  const char* nm_filename;
  napi_addon_register_func nm_register_func;
  const char* nm_modname;
  void* nm_priv;
  void* reserved[4];
} napi_module;

extern void napi_module_register(napi_module* mod);

typedef struct {
  napi_env env;
  int listen_fd;
  dev_t dev;
  ino_t ino;
  gid_t gid;
  mode_t mode;
  int closed;
  napi_ref cb_ref;
  uv_poll_t* poll;
  char socket_path[sizeof(((struct sockaddr_un*)0)->sun_path)];
} ListenerState;

static void on_poll_closed(uv_handle_t* handle) {
  free(handle);
}

static bool socket_matches_state(const ListenerState* state) {
  if (state == NULL || state->closed || state->socket_path[0] == '\\0') {
    return false;
  }
  struct stat st;
  if (lstat(state->socket_path, &st) != 0) {
    return false;
  }
  return S_ISSOCK(st.st_mode) &&
         st.st_dev == state->dev &&
         st.st_ino == state->ino &&
         st.st_uid == 0 &&
         st.st_gid == state->gid &&
         (st.st_mode & 07777) == state->mode;
}

static void close_listener_state(napi_env env, ListenerState* state) {
  if (state == NULL || state->closed) {
    return;
  }
  state->closed = 1;
  if (state->poll != NULL) {
    state->poll->data = NULL;
    uv_poll_stop(state->poll);
  }
  if (state->listen_fd >= 0) {
    close(state->listen_fd);
    state->listen_fd = -1;
  }
  if (state->socket_path[0] != '\\0') {
    struct stat st;
    if (lstat(state->socket_path, &st) == 0 &&
        S_ISSOCK(st.st_mode) &&
        st.st_dev == state->dev &&
        st.st_ino == state->ino) {
      unlink(state->socket_path);
    }
    state->socket_path[0] = '\\0';
  }
  if (env != NULL && state->cb_ref != NULL) {
    napi_delete_reference(env, state->cb_ref);
    state->cb_ref = NULL;
  }
  if (state->poll != NULL) {
    uv_close((uv_handle_t*)state->poll, on_poll_closed);
    state->poll = NULL;
  }
}

static void finalize_listener(napi_env env, void* finalize_data, void* finalize_hint) {
  (void)finalize_hint;
  ListenerState* state = (ListenerState*)finalize_data;
  if (state != NULL) {
    close_listener_state(env, state);
    free(state);
  }
}

static void on_poll_readable(uv_poll_t* handle, int status, int events) {
  (void)status;
  (void)events;
  ListenerState* state = (ListenerState*)handle->data;
  if (state == NULL || state->closed || state->env == NULL || state->cb_ref == NULL) {
    return;
  }
  napi_handle_scope scope = NULL;
  if (napi_open_handle_scope(state->env, &scope) != napi_ok || scope == NULL) {
    return;
  }
  napi_value cb = NULL;
  napi_value global = NULL;
  if (napi_get_reference_value(state->env, state->cb_ref, &cb) == napi_ok &&
      napi_get_global(state->env, &global) == napi_ok &&
      cb != NULL && global != NULL) {
    napi_call_function(state->env, global, cb, 0, NULL, NULL);
  }
  napi_close_handle_scope(state->env, scope);
}

static napi_value build_cred_object(napi_env env, int fd, const struct ucred* cred) {
  napi_value obj = NULL;
  napi_value v_uid = NULL;
  napi_value v_gid = NULL;
  napi_value v_pid = NULL;
  if (napi_create_object(env, &obj) != napi_ok ||
      napi_create_uint32(env, (uint32_t)cred->uid, &v_uid) != napi_ok ||
      napi_create_uint32(env, (uint32_t)cred->gid, &v_gid) != napi_ok ||
      napi_create_int32(env, (int32_t)cred->pid, &v_pid) != napi_ok ||
      napi_set_named_property(env, obj, "uid", v_uid) != napi_ok ||
      napi_set_named_property(env, obj, "gid", v_gid) != napi_ok ||
      napi_set_named_property(env, obj, "pid", v_pid) != napi_ok) {
    return NULL;
  }
  if (fd >= 0) {
    napi_value v_fd = NULL;
    if (napi_create_int32(env, (int32_t)fd, &v_fd) != napi_ok ||
        napi_set_named_property(env, obj, "fd", v_fd) != napi_ok) {
      return NULL;
    }
  }
  return obj;
}

static napi_value napi_open_listener(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 5) {
    napi_throw_error(env, "PRECONDITION_FAILED", "openListener requires socketPath, gid, mode, backlog, and onReadable");
    return NULL;
  }

  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;

  size_t path_len = 0;
  if (napi_get_value_string_utf8(env, argv[0], addr.sun_path, sizeof(addr.sun_path), &path_len) != napi_ok ||
      path_len == 0 || path_len >= sizeof(addr.sun_path) || addr.sun_path[0] != '/') {
    napi_throw_error(env, "PRECONDITION_FAILED", "agent socket path must be a valid absolute UNIX socket path");
    return NULL;
  }

  uint32_t gid = 0;
  uint32_t mode = 0;
  int32_t backlog = 32;
  if (napi_get_value_uint32(env, argv[1], &gid) != napi_ok || gid == 0 ||
      napi_get_value_uint32(env, argv[2], &mode) != napi_ok ||
      napi_get_value_int32(env, argv[3], &backlog) != napi_ok) {
    napi_throw_error(env, "PRECONDITION_FAILED", "invalid agent socket listener parameters");
    return NULL;
  }

  struct stat existing;
  if (lstat(addr.sun_path, &existing) == 0 || errno != ENOENT) {
    napi_throw_error(env, "EEXIST", "refusing to overwrite an existing agent socket path");
    return NULL;
  }

  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    napi_throw_error(env, "PRECONDITION_FAILED", "unable to create AF_UNIX stream socket");
    return NULL;
  }

  mode_t previous_umask = umask(0077);
  int bind_rc = bind(fd, (const struct sockaddr*)&addr, (socklen_t)sizeof(addr));
  umask(previous_umask);
  if (bind_rc != 0) {
    close(fd);
    napi_throw_error(env, "PRECONDITION_FAILED", "unable to bind AF_UNIX agent socket");
    return NULL;
  }

  mode_t expected_mode = (mode_t)(mode & 0777);
  if (chown(addr.sun_path, 0, (gid_t)gid) != 0 || chmod(addr.sun_path, expected_mode) != 0) {
    unlink(addr.sun_path);
    close(fd);
    napi_throw_error(env, "PRECONDITION_FAILED", "unable to apply ownership and mode to agent socket");
    return NULL;
  }

  struct stat bound_stat;
  if (lstat(addr.sun_path, &bound_stat) != 0 ||
      !S_ISSOCK(bound_stat.st_mode) ||
      bound_stat.st_uid != 0 ||
      bound_stat.st_gid != (gid_t)gid ||
      (bound_stat.st_mode & 07777) != expected_mode) {
    unlink(addr.sun_path);
    close(fd);
    napi_throw_error(env, "PRECONDITION_FAILED", "verified agent socket metadata did not match contract");
    return NULL;
  }

  if (listen(fd, backlog > 0 ? backlog : 32) != 0) {
    unlink(addr.sun_path);
    close(fd);
    napi_throw_error(env, "PRECONDITION_FAILED", "unable to listen on AF_UNIX agent socket");
    return NULL;
  }

  uv_loop_t* loop = NULL;
  if (napi_get_uv_event_loop(env, &loop) != napi_ok || loop == NULL) {
    unlink(addr.sun_path);
    close(fd);
    napi_throw_error(env, "PRECONDITION_FAILED", "unable to acquire libuv event loop");
    return NULL;
  }

  ListenerState* state = (ListenerState*)calloc(1, sizeof(ListenerState));
  uv_poll_t* poll = (uv_poll_t*)calloc(1, sizeof(uv_poll_t));
  if (state == NULL || poll == NULL) {
    free(state);
    free(poll);
    unlink(addr.sun_path);
    close(fd);
    napi_throw_error(env, "PRECONDITION_FAILED", "unable to allocate native listener state");
    return NULL;
  }

  state->env = env;
  state->listen_fd = fd;
  state->dev = bound_stat.st_dev;
  state->ino = bound_stat.st_ino;
  state->gid = (gid_t)gid;
  state->mode = expected_mode;
  state->closed = 0;
  state->poll = poll;
  memcpy(state->socket_path, addr.sun_path, path_len + 1);

  if (napi_create_reference(env, argv[4], 1, &state->cb_ref) != napi_ok ||
      uv_poll_init(loop, poll, fd) != 0) {
    if (state->cb_ref != NULL) napi_delete_reference(env, state->cb_ref);
    free(poll);
    free(state);
    unlink(addr.sun_path);
    close(fd);
    napi_throw_error(env, "PRECONDITION_FAILED", "unable to initialize libuv poll watcher for agent socket");
    return NULL;
  }

  poll->data = state;
  if (uv_poll_start(poll, UV_READABLE, on_poll_readable) != 0) {
    close_listener_state(env, state);
    free(state);
    napi_throw_error(env, "PRECONDITION_FAILED", "unable to start libuv poll watcher for agent socket");
    return NULL;
  }

  napi_value external = NULL;
  if (napi_create_external(env, state, finalize_listener, NULL, &external) != napi_ok) {
    close_listener_state(env, state);
    free(state);
    napi_throw_error(env, "PRECONDITION_FAILED", "unable to wrap native listener handle");
    return NULL;
  }
  return external;
}

static napi_value napi_accept_peer(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  ListenerState* state = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc < 1 ||
      napi_get_value_external(env, argv[0], (void**)&state) != napi_ok ||
      state == NULL || state->closed || state->listen_fd < 0) {
    napi_throw_error(env, "PRECONDITION_FAILED", "agent socket listener is not active");
    return NULL;
  }

  int client_fd = accept4(state->listen_fd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
  if (client_fd < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) {
      napi_value null_val = NULL;
      napi_get_null(env, &null_val);
      return null_val;
    }
    napi_throw_error(env, "ACCEPT_FAILED", "failed to accept connection on agent socket");
    return NULL;
  }

  if (!socket_matches_state(state)) {
    close(client_fd);
    napi_throw_error(env, "SOCKET_REPLACED", "agent socket path was replaced or modified on disk");
    return NULL;
  }

  struct ucred cred;
  socklen_t cred_len = (socklen_t)sizeof(cred);
  memset(&cred, 0, sizeof(cred));
  if (getsockopt(client_fd, SOL_SOCKET, SO_PEERCRED, &cred, &cred_len) != 0 ||
      cred_len != (socklen_t)sizeof(cred) ||
      cred.pid <= 0) {
    close(client_fd);
    napi_throw_error(env, "PEERCRED_FAILED", "kernel SO_PEERCRED lookup failed on accepted socket");
    return NULL;
  }

  napi_value obj = build_cred_object(env, client_fd, &cred);
  if (obj == NULL) {
    close(client_fd);
    napi_throw_error(env, "PRECONDITION_FAILED", "failed to construct peer credential result");
    return NULL;
  }
  return obj;
}

static napi_value napi_verify_listener_socket(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  ListenerState* state = NULL;
  bool ok = false;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok &&
      argc >= 1 &&
      napi_get_value_external(env, argv[0], (void**)&state) == napi_ok) {
    ok = socket_matches_state(state);
  }
  napi_value result = NULL;
  napi_get_boolean(env, ok, &result);
  return result;
}

static napi_value napi_close_listener(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  ListenerState* state = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok &&
      argc >= 1 &&
      napi_get_value_external(env, argv[0], (void**)&state) == napi_ok &&
      state != NULL) {
    close_listener_state(env, state);
  }
  napi_value undef = NULL;
  napi_get_undefined(env, &undef);
  return undef;
}

static napi_value napi_close_fd(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t fd = -1;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok &&
      argc >= 1 &&
      napi_get_value_int32(env, argv[0], &fd) == napi_ok &&
      fd >= 0) {
    close(fd);
  }
  napi_value undef = NULL;
  napi_get_undefined(env, &undef);
  return undef;
}

static napi_value napi_get_socket_peer_cred(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t fd = -1;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc < 1 ||
      napi_get_value_int32(env, argv[0], &fd) != napi_ok ||
      fd < 0) {
    napi_throw_error(env, "PRECONDITION_FAILED", "getSocketPeerCred requires a valid file descriptor");
    return NULL;
  }

  struct ucred cred;
  socklen_t cred_len = (socklen_t)sizeof(cred);
  memset(&cred, 0, sizeof(cred));
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &cred_len) != 0 ||
      cred_len != (socklen_t)sizeof(cred) ||
      cred.pid <= 0) {
    napi_throw_error(env, "PEERCRED_FAILED", "kernel SO_PEERCRED lookup failed");
    return NULL;
  }

  napi_value obj = build_cred_object(env, -1, &cred);
  if (obj == NULL) {
    napi_throw_error(env, "PRECONDITION_FAILED", "failed to construct peer credential result");
    return NULL;
  }
  return obj;
}

static napi_value init_peer_identity(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
    { "openListener", NULL, napi_open_listener, NULL, NULL, NULL, napi_default, NULL },
    { "acceptPeer", NULL, napi_accept_peer, NULL, NULL, NULL, napi_default, NULL },
    { "verifyListenerSocket", NULL, napi_verify_listener_socket, NULL, NULL, NULL, napi_default, NULL },
    { "closeListener", NULL, napi_close_listener, NULL, NULL, NULL, napi_default, NULL },
    { "closeFd", NULL, napi_close_fd, NULL, NULL, NULL, napi_default, NULL },
    { "getSocketPeerCred", NULL, napi_get_socket_peer_cred, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, sizeof(descriptors) / sizeof(descriptors[0]), descriptors);
  return exports;
}

static napi_module peer_identity_module = {
  1,
  0,
  __FILE__,
  init_peer_identity,
  "xpanel_peer_identity",
  NULL,
  { 0, 0, 0, 0 }
};

__attribute__((constructor)) static void register_peer_identity_module(void) {
  napi_module_register(&peer_identity_module);
}
`

let cachedNativeAddon: NativePeerIdentityAddon | null = null

const verifyRootOwnedDirectoryChain = async (dirPath: string): Promise<void> => {
  if (process.platform !== 'linux' || !isAbsolute(dirPath)) {
    fail('PRECONDITION_FAILED', 'native peer identity directory requires an absolute Linux path')
  }
  let current = resolve(dirPath)
  while (true) {
    const metadata = await lstat(current)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      fail('PRECONDITION_FAILED', `native peer identity path must traverse root-owned non-writable directories: ${current}`)
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

const verifyCompiledAddonBinary = async (binaryPath: string, expectedSha256?: string): Promise<string> => {
  await verifyRootOwnedDirectoryChain(dirname(binaryPath))
  const handle = await open(binaryPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = await handle.stat()
    if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) !== 0 || (st.mode & 0o6000) !== 0) {
      fail('PRECONDITION_FAILED', 'native peer identity binary must be a root-owned non-writable regular file without set-ID bits')
    }
    const content = await handle.readFile()
    const digest = createHash('sha256').update(content).digest('hex')
    if (expectedSha256 && digest !== expectedSha256) {
      fail('PRECONDITION_FAILED', 'native peer identity binary digest mismatch')
    }
    return digest
  } finally {
    await handle.close()
  }
}

const resolveCompilerExecutable = (): string => {
  for (const candidate of ['/usr/bin/gcc', '/usr/bin/cc', '/bin/gcc', '/bin/cc']) {
    if (existsSync(candidate)) {
      try {
        return realpathSync(candidate)
      } catch {
        continue
      }
    }
  }
  return fail('PRECONDITION_FAILED', 'a root-owned C compiler (/usr/bin/gcc or /usr/bin/cc) is required to build the native SO_PEERCRED verifier')
}

export const getPeerIdentitySourceDigest = (): string =>
  createHash('sha256')
    .update(PEER_IDENTITY_C_SOURCE)
    .update(process.version)
    .update(process.arch)
    .digest('hex')

/**
 * Compiles (if absent) and loads the audited C N-API SO_PEERCRED addon on Linux.
 * Fails closed (`PRECONDITION_FAILED`) if not running as root on Linux or if
 * compilation/verification fails.
 */
export const loadNativePeerIdentityAddon = async (options?: {
  cacheDir?: string
  forceRebuild?: boolean
}): Promise<NativePeerIdentityAddon> => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    fail('PRECONDITION_FAILED', 'kernel SO_PEERCRED native verifier requires root on Linux')
  }
  if (cachedNativeAddon && !options?.cacheDir && !options?.forceRebuild) {
    return cachedNativeAddon
  }

  const prebuiltPath = '/opt/xpanel/bin/xpanel-peer-identity.node'
  if (!options?.cacheDir && !options?.forceRebuild && existsSync(prebuiltPath)) {
    await verifyCompiledAddonBinary(prebuiltPath)
    const mod = { exports: {} as NativePeerIdentityAddon }
    process.dlopen(mod, prebuiltPath)
    cachedNativeAddon = mod.exports
    return mod.exports
  }

  const cacheRoot = resolve(options?.cacheDir ?? '/var/cache/xpanel/native')
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  await chown(cacheRoot, 0, 0)
  await chmod(cacheRoot, 0o700)
  await verifyRootOwnedDirectoryChain(cacheRoot)

  const sourceDigest = getPeerIdentitySourceDigest()
  const binaryPath = join(cacheRoot, `peer-identity-${sourceDigest.slice(0, 32)}.node`)
  const digestPath = `${binaryPath}.sha256`

  if (!options?.forceRebuild && existsSync(binaryPath) && existsSync(digestPath)) {
    const expectedSha = (await readFile(digestPath, 'utf8').catch(() => '')).trim()
    if (/^[0-9a-f]{64}$/.test(expectedSha)) {
      await verifyCompiledAddonBinary(binaryPath, expectedSha)
      const mod = { exports: {} as NativePeerIdentityAddon }
      process.dlopen(mod, binaryPath)
      if (!options?.cacheDir) cachedNativeAddon = mod.exports
      return mod.exports
    }
  }

  const compiler = resolveCompilerExecutable()
  await verifyCompiledAddonBinary(compiler)

  const uniqueSuffix = `${process.pid}.${randomBytes(6).toString('hex')}`
  const tempSourcePath = join(cacheRoot, `peer-identity-${uniqueSuffix}.c`)
  const tempBinaryPath = join(cacheRoot, `peer-identity-${uniqueSuffix}.node`)
  const tempDigestPath = join(cacheRoot, `peer-identity-${uniqueSuffix}.sha256`)

  try {
    await writeFile(tempSourcePath, PEER_IDENTITY_C_SOURCE, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await chown(tempSourcePath, 0, 0)
    await chmod(tempSourcePath, 0o600)

    const compileResult = spawnSync(
      compiler,
      ['-shared', '-fPIC', '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-o', tempBinaryPath, tempSourcePath],
      {
        encoding: 'utf8',
        timeout: 20_000,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      },
    )

    if (compileResult.status !== 0 || compileResult.error) {
      fail('PRECONDITION_FAILED', 'failed to compile native SO_PEERCRED verifier')
    }

    await chown(tempBinaryPath, 0, 0)
    await chmod(tempBinaryPath, 0o500)
    const compiledSha = await verifyCompiledAddonBinary(tempBinaryPath)
    await writeFile(tempDigestPath, `${compiledSha}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await chown(tempDigestPath, 0, 0)
    await chmod(tempDigestPath, 0o600)

    await rename(tempBinaryPath, binaryPath)
    await rename(tempDigestPath, digestPath)
  } finally {
    await rm(tempSourcePath, { force: true }).catch(() => undefined)
    await rm(tempBinaryPath, { force: true }).catch(() => undefined)
    await rm(tempDigestPath, { force: true }).catch(() => undefined)
  }

  const expectedSha = (await readFile(digestPath, 'utf8')).trim()
  await verifyCompiledAddonBinary(binaryPath, expectedSha)

  try {
    const mod = { exports: {} as NativePeerIdentityAddon }
    process.dlopen(mod, binaryPath)
    if (
      typeof mod.exports.openListener !== 'function' ||
      typeof mod.exports.acceptPeer !== 'function' ||
      typeof mod.exports.verifyListenerSocket !== 'function' ||
      typeof mod.exports.closeListener !== 'function' ||
      typeof mod.exports.closeFd !== 'function' ||
      typeof mod.exports.getSocketPeerCred !== 'function'
    ) {
      fail('PRECONDITION_FAILED', 'native SO_PEERCRED verifier did not export the required interface')
    }
    if (!options?.cacheDir) cachedNativeAddon = mod.exports
    return mod.exports
  } catch (err) {
    if (isXpanelError(err)) throw err
    return fail('PRECONDITION_FAILED', 'unable to load native SO_PEERCRED verifier')
  }
}
