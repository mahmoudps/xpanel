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
#include <limits.h>
#include <poll.h>
#include <time.h>
#include <netinet/tcp.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#include <linux/sock_diag.h>
#include <linux/unix_diag.h>

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
extern napi_status napi_get_value_double(napi_env env, napi_value value, double* result);
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

/* Read-only exact AF_UNIX diagnostic query for a caller-held connected FD. */
static int64_t peer_monotonic_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static napi_value napi_get_unix_socket_peer(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  double supplied_fd = -1;
  int held_fd = -1, diagnostic_fd = -1;
  uint32_t peer_inode = 0;
  uint64_t cookie = 0, final_cookie = 0;
  struct stat initial, final;
  if (getuid() != 0 || geteuid() != 0 ||
      napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_double(env, argv[0], &supplied_fd) != napi_ok ||
      supplied_fd != supplied_fd || supplied_fd < 0 || supplied_fd > INT_MAX) {
    napi_throw_error(env, "PRECONDITION_FAILED", "a root-owned connected Unix socket FD is required");
    return NULL;
  }
  int original_fd = (int)supplied_fd;
  if (supplied_fd != (double)original_fd) goto unavailable;
  held_fd = fcntl(original_fd, F_DUPFD_CLOEXEC, 3);
  if (held_fd < 0 || fstat(held_fd, &initial) != 0 || !S_ISSOCK(initial.st_mode) ||
      initial.st_ino == 0 || (uint64_t)initial.st_ino > UINT32_MAX) goto unavailable;
  int socket_type = 0;
  socklen_t size = sizeof(socket_type);
  struct sockaddr_storage address;
  socklen_t address_size = sizeof(address);
  memset(&address, 0, sizeof(address));
  if (getsockopt(held_fd, SOL_SOCKET, SO_TYPE, &socket_type, &size) != 0 ||
      size != sizeof(socket_type) || socket_type != SOCK_STREAM ||
      getsockname(held_fd, (struct sockaddr*)&address, &address_size) != 0 || address.ss_family != AF_UNIX) goto unavailable;
  address_size = sizeof(address);
  if (getpeername(held_fd, (struct sockaddr*)&address, &address_size) != 0 || address.ss_family != AF_UNIX) goto unavailable;
  size = sizeof(cookie);
  if (getsockopt(held_fd, SOL_SOCKET, SO_COOKIE, &cookie, &size) != 0 || size != sizeof(cookie) || cookie == 0 || cookie == UINT64_MAX) goto unavailable;

  diagnostic_fd = socket(AF_NETLINK, SOCK_RAW | SOCK_NONBLOCK | SOCK_CLOEXEC, NETLINK_SOCK_DIAG);
  if (diagnostic_fd < 0) goto unavailable;
  struct sockaddr_nl local, kernel;
  memset(&local, 0, sizeof(local)); memset(&kernel, 0, sizeof(kernel));
  local.nl_family = AF_NETLINK; kernel.nl_family = AF_NETLINK;
  if (bind(diagnostic_fd, (struct sockaddr*)&local, sizeof(local)) != 0) goto unavailable;
  struct { struct nlmsghdr header; struct unix_diag_req request; } query;
  memset(&query, 0, sizeof(query));
  query.header.nlmsg_len = NLMSG_LENGTH(sizeof(query.request));
  query.header.nlmsg_type = SOCK_DIAG_BY_FAMILY;
  query.header.nlmsg_flags = NLM_F_REQUEST;
  query.header.nlmsg_seq = 1;
  query.request.sdiag_family = AF_UNIX;
  query.request.udiag_states = UINT32_MAX;
  query.request.udiag_ino = (uint32_t)initial.st_ino;
  query.request.udiag_show = UDIAG_SHOW_PEER;
  query.request.udiag_cookie[0] = (uint32_t)cookie;
  query.request.udiag_cookie[1] = (uint32_t)(cookie >> 32);
  if (sendto(diagnostic_fd, &query, query.header.nlmsg_len, MSG_DONTWAIT,
      (struct sockaddr*)&kernel, sizeof(kernel)) != (ssize_t)query.header.nlmsg_len) goto unavailable;
  int64_t started = peer_monotonic_ms();
  if (started < 0) goto unavailable;
  const int64_t deadline = started + 250;
  bool found = false;
  for (unsigned attempts = 0; attempts < 8 && !found; attempts++) {
    int64_t now = peer_monotonic_ms();
    if (now < 0 || now >= deadline) goto unavailable;
    struct pollfd ready = { diagnostic_fd, POLLIN, 0 };
    int polled = poll(&ready, 1, (int)(deadline - now));
    if (polled < 0 && errno == EINTR) continue;
    if (polled != 1 || !(ready.revents & POLLIN) || (ready.revents & (POLLERR | POLLHUP | POLLNVAL))) goto unavailable;
    union { struct nlmsghdr alignment; unsigned char bytes[8192]; } response;
    struct sockaddr_nl sender;
    struct iovec vector = { response.bytes, sizeof(response.bytes) };
    struct msghdr message;
    memset(&sender, 0, sizeof(sender)); memset(&message, 0, sizeof(message));
    message.msg_name = &sender; message.msg_namelen = sizeof(sender);
    message.msg_iov = &vector; message.msg_iovlen = 1;
    ssize_t received = recvmsg(diagnostic_fd, &message, MSG_DONTWAIT);
    if (received < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) continue;
    if (received <= 0 || received > (ssize_t)sizeof(response.bytes) || (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) ||
        message.msg_namelen != sizeof(sender) || sender.nl_family != AF_NETLINK || sender.nl_pid != 0) goto unavailable;
    int remaining = (int)received;
    struct nlmsghdr* header = (struct nlmsghdr*)response.bytes;
    for (; NLMSG_OK(header, remaining); header = NLMSG_NEXT(header, remaining)) {
      if (found || header->nlmsg_seq != query.header.nlmsg_seq || header->nlmsg_type != SOCK_DIAG_BY_FAMILY ||
          header->nlmsg_len < NLMSG_LENGTH(sizeof(struct unix_diag_msg))) goto unavailable;
      struct unix_diag_msg* record = (struct unix_diag_msg*)NLMSG_DATA(header);
      if (record->udiag_family != AF_UNIX || record->udiag_type != SOCK_STREAM || record->udiag_state != TCP_ESTABLISHED ||
          record->udiag_ino != (uint32_t)initial.st_ino || record->udiag_cookie[0] != (uint32_t)cookie ||
          record->udiag_cookie[1] != (uint32_t)(cookie >> 32)) goto unavailable;
      int attributes = (int)(header->nlmsg_len - NLMSG_LENGTH(sizeof(*record)));
      struct rtattr* attribute = (struct rtattr*)((unsigned char*)record + NLMSG_ALIGN(sizeof(*record)));
      bool has_peer = false;
      for (; RTA_OK(attribute, attributes); attribute = RTA_NEXT(attribute, attributes)) {
        if (attribute->rta_type == UNIX_DIAG_PEER) {
          if (has_peer || RTA_PAYLOAD(attribute) != sizeof(peer_inode)) goto unavailable;
          memcpy(&peer_inode, RTA_DATA(attribute), sizeof(peer_inode)); has_peer = true;
        } else if (attribute->rta_type == UNIX_DIAG_SHUTDOWN) {
          unsigned char shutdown_state = 0;
          if (RTA_PAYLOAD(attribute) != sizeof(shutdown_state)) goto unavailable;
          memcpy(&shutdown_state, RTA_DATA(attribute), sizeof(shutdown_state));
          if (shutdown_state != 0) goto unavailable;
        }
      }
      if (attributes != 0 || !has_peer || peer_inode == 0 || peer_inode == (uint32_t)initial.st_ino) goto unavailable;
      found = true;
    }
    if (remaining != 0) goto unavailable;
  }
  if (!found || fstat(held_fd, &final) != 0 || final.st_dev != initial.st_dev || final.st_ino != initial.st_ino) goto unavailable;
  size = sizeof(final_cookie);
  if (getsockopt(held_fd, SOL_SOCKET, SO_COOKIE, &final_cookie, &size) != 0 || size != sizeof(final_cookie) || final_cookie != cookie) goto unavailable;
  int64_t finished = peer_monotonic_ms();
  if (finished < 0 || finished >= deadline) goto unavailable;
  unsigned char peek;
  ssize_t available = recv(held_fd, &peek, 1, MSG_PEEK | MSG_DONTWAIT);
  if (available == 0 || (available < 0 && errno != EAGAIN && errno != EWOULDBLOCK)) goto unavailable;
  close(diagnostic_fd); diagnostic_fd = -1; close(held_fd); held_fd = -1;
  napi_value output, local_value, peer_value, low_value, high_value;
  if (napi_create_object(env, &output) != napi_ok ||
      napi_create_uint32(env, (uint32_t)initial.st_ino, &local_value) != napi_ok ||
      napi_create_uint32(env, peer_inode, &peer_value) != napi_ok ||
      napi_create_uint32(env, (uint32_t)cookie, &low_value) != napi_ok ||
      napi_create_uint32(env, (uint32_t)(cookie >> 32), &high_value) != napi_ok ||
      napi_set_named_property(env, output, "socketInode", local_value) != napi_ok ||
      napi_set_named_property(env, output, "peerInode", peer_value) != napi_ok ||
      napi_set_named_property(env, output, "cookieLo", low_value) != napi_ok ||
      napi_set_named_property(env, output, "cookieHi", high_value) != napi_ok) goto unavailable;
  return output;

unavailable:
  if (diagnostic_fd >= 0) close(diagnostic_fd);
  if (held_fd >= 0) close(held_fd);
  napi_throw_error(env, "UNIX_SOCKET_RELATION_UNAVAILABLE", "the held Unix socket has no verified live kernel peer relation");
  return NULL;
}

static napi_value init_peer_identity(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
    { "openListener", NULL, napi_open_listener, NULL, NULL, NULL, napi_default, NULL },
    { "acceptPeer", NULL, napi_accept_peer, NULL, NULL, NULL, napi_default, NULL },
    { "verifyListenerSocket", NULL, napi_verify_listener_socket, NULL, NULL, NULL, napi_default, NULL },
    { "closeListener", NULL, napi_close_listener, NULL, NULL, NULL, napi_default, NULL },
    { "closeFd", NULL, napi_close_fd, NULL, NULL, NULL, napi_default, NULL },
    { "getSocketPeerCred", NULL, napi_get_socket_peer_cred, NULL, NULL, NULL, napi_default, NULL },
    { "getUnixSocketPeer", NULL, napi_get_unix_socket_peer, NULL, NULL, NULL, napi_default, NULL },
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
