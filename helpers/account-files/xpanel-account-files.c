#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <inttypes.h>
#include <limits.h>
#include <linux/fs.h>
#include <linux/magic.h>
#include <linux/openat2.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/file.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/vfs.h>
#include <time.h>
#include <unistd.h>

#ifndef SYS_openat2
#define SYS_openat2 437
#endif

#ifndef SYS_close_range
#define SYS_close_range 436
#endif

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1U << 0)
#endif

#define XP_PROTOCOL_VERSION 2
#define XP_MAX_STDIN_BYTES (4 * 1024 * 1024)
#define XP_MAX_EDIT_BYTES_CEILING (1024 * 1024)
#define XP_MAX_BINARY_BYTES (2 * 1024 * 1024)
#define XP_MAX_LIST_ENTRIES_CEILING 10000
#define XP_MAX_COPY_BYTES (128LL * 1024 * 1024)
#define XP_COPY_LIMIT_MESSAGE "copy exceeds the entry or 128 MiB size limit"
#define XP_MAX_TREE_DEPTH 32
#define XP_MAX_PATH_BYTES 4096
#define XP_MIN_ACCOUNT_ID 1000
#define XP_MAX_ACCOUNT_ID 65533
#define XP_RESOLVE_CONFINED (RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV)

typedef struct {
  char *data;
  size_t len;
  size_t cap;
} StrBuf;

static void sb_init(StrBuf *sb, size_t initial_cap) {
  sb->cap = initial_cap < 256 ? 256 : initial_cap;
  sb->data = calloc(1, sb->cap);
  if (!sb->data) _exit(12);
  sb->len = 0;
}

static void sb_ensure(StrBuf *sb, size_t extra) {
  if (sb->len + extra + 1 <= sb->cap) return;
  size_t next = sb->cap;
  while (sb->len + extra + 1 > next) next *= 2;
  char *p = realloc(sb->data, next);
  if (!p) _exit(12);
  sb->data = p;
  sb->cap = next;
}

static void sb_append_mem(StrBuf *sb, const char *mem, size_t n) {
  sb_ensure(sb, n);
  memcpy(sb->data + sb->len, mem, n);
  sb->len += n;
  sb->data[sb->len] = '\0';
}

static void sb_append_str(StrBuf *sb, const char *s) {
  sb_append_mem(sb, s, strlen(s));
}

static void sb_append_char(StrBuf *sb, char c) {
  sb_ensure(sb, 1);
  sb->data[sb->len++] = c;
  sb->data[sb->len] = '\0';
}

static void sb_append_fmt(StrBuf *sb, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
static void sb_append_fmt(StrBuf *sb, const char *fmt, ...) {
  va_list ap, ap2;
  va_start(ap, fmt);
  va_copy(ap2, ap);
  int needed = vsnprintf(NULL, 0, fmt, ap);
  va_end(ap);
  if (needed < 0) {
    va_end(ap2);
    _exit(12);
  }
  sb_ensure(sb, (size_t)needed);
  vsnprintf(sb->data + sb->len, (size_t)needed + 1, fmt, ap2);
  sb->len += (size_t)needed;
  va_end(ap2);
}

static void sb_append_json_str(StrBuf *sb, const char *s, size_t len) {
  sb_append_char(sb, '"');
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)s[i];
    switch (c) {
      case '"': sb_append_str(sb, "\\\""); break;
      case '\\': sb_append_str(sb, "\\\\"); break;
      case '\b': sb_append_str(sb, "\\b"); break;
      case '\f': sb_append_str(sb, "\\f"); break;
      case '\n': sb_append_str(sb, "\\n"); break;
      case '\r': sb_append_str(sb, "\\r"); break;
      case '\t': sb_append_str(sb, "\\t"); break;
      default:
        if (c < 0x20 || c == 0x7f) {
          sb_append_fmt(sb, "\\u%04x", (unsigned int)c);
        } else {
          sb_append_char(sb, (char)c);
        }
        break;
    }
  }
  sb_append_char(sb, '"');
}

static void sb_append_json_cstr(StrBuf *sb, const char *s) {
  sb_append_json_str(sb, s ? s : "", s ? strlen(s) : 0);
}

typedef struct {
  pid_t pid;
  uid_t uid;
  gid_t gid;
  char cgroup[512];
  char op[32];
  int64_t hold_open_ms;
} WorkerState;

static WorkerState g_worker = {0};

static const char *errno_to_name(int err) {
  switch (err) {
    case 0: return "OK";
    case EPERM: return "EPERM";
    case ENOENT: return "ENOENT";
    case EIO: return "EIO";
    case EBADF: return "EBADF";
    case EAGAIN: return "EAGAIN";
    case ENOMEM: return "ENOMEM";
    case EACCES: return "EACCES";
    case EEXIST: return "EEXIST";
    case EXDEV: return "EXDEV";
    case ENOTDIR: return "ENOTDIR";
    case EISDIR: return "EISDIR";
    case EINVAL: return "EINVAL";
    case ENOSPC: return "ENOSPC";
    case EROFS: return "EROFS";
    case EMLINK: return "EMLINK";
    case EOVERFLOW: return "EOVERFLOW";
    case EPROTO: return "EPROTO";
    case ELOOP: return "ELOOP";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case ENOSYS: return "ENOSYS";
    case ENOTEMPTY: return "ENOTEMPTY";
    case EDQUOT: return "EDQUOT";
    default: return "EUNKNOWN";
  }
}

static const char *errno_to_xpanel_code(int err) {
  switch (err) {
    case ENOENT:
    case ENOTDIR:
      return "NOT_FOUND";
    case EEXIST:
    case ENOTEMPTY:
    case EISDIR:
      return "CONFLICT";
    case EDQUOT:
    case ENOSPC:
    case EMLINK:
      return "LIMIT_EXCEEDED";
    case EACCES:
    case EPERM:
    case ELOOP:
    case EXDEV:
    case EAGAIN:
    case EROFS:
      return "FORBIDDEN";
    case ENOSYS:
      return "PRECONDITION_FAILED";
    case EINVAL:
    case ENAMETOOLONG:
      return "VALIDATION";
    default:
      return "CONFIG_TEST_FAILED";
  }
}

static void write_all_stdout(const char *buf, size_t len) {
  size_t off = 0;
  while (off < len) {
    ssize_t n = write(STDOUT_FILENO, buf + off, len - off);
    if (n < 0) {
      if (errno == EINTR) continue;
      _exit(1);
    }
    off += (size_t)n;
  }
}

static bool canonical_cgroup_path(const char *path) {
  if (!path || path[0] != '/') return false;
  if (path[1] == '\0') return true;
  const char *segment = path + 1;
  for (const char *p = segment; ; p++) {
    unsigned char c = (unsigned char)*p;
    if (c != '\0' && (c <= 0x20 || c == 0x7f || c == '\\')) return false;
    if (c == '/' || c == '\0') {
      size_t len = (size_t)(p - segment);
      if (len == 0 || (len == 1 && segment[0] == '.') ||
          (len == 2 && segment[0] == '.' && segment[1] == '.')) return false;
      if (c == '\0') return true;
      segment = p + 1;
    }
  }
}

static bool read_self_cgroup(char out[512]) {
  snprintf(out, 512, "unknown");
  int fd = open("/proc/self/cgroup", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return false;
  char buf[4096];
  size_t used = 0;
  bool failed = false;
  while (used < sizeof(buf) - 1) {
    ssize_t n = read(fd, buf + used, sizeof(buf) - 1 - used);
    if (n < 0) { if (errno == EINTR) continue; failed = true; break; }
    if (n == 0) break;
    used += (size_t)n;
  }
  if (used == sizeof(buf) - 1) {
    char extra;
    ssize_t n;
    do { n = read(fd, &extra, 1); } while (n < 0 && errno == EINTR);
    if (n != 0) failed = true;
  }
  close(fd);
  if (failed || used == 0) return false;
  buf[used] = '\0';
  bool found = false;
  for (char *line = buf; line && *line; ) {
    char *next = strchr(line, '\n');
    if (next) *next++ = '\0';
    if (strncmp(line, "0::", 3) == 0) {
      const char *path = line + 3;
      size_t len = strlen(path);
      if (found || len >= 512 || !canonical_cgroup_path(path)) return false;
      memcpy(out, path, len + 1);
      found = true;
    }
    line = next;
  }
  if (!found) snprintf(out, 512, "unknown");
  return found;
}

static void refresh_worker_state(void) {
  g_worker.pid = getpid();
  g_worker.uid = geteuid();
  g_worker.gid = getegid();
  read_self_cgroup(g_worker.cgroup);
}

static void maybe_hold_open(void) {
  if (g_worker.hold_open_ms > 0 && g_worker.hold_open_ms <= 2000) {
    struct timespec req_ts;
    req_ts.tv_sec = (time_t)(g_worker.hold_open_ms / 1000);
    req_ts.tv_nsec = (long)((g_worker.hold_open_ms % 1000) * 1000000L);
    (void)nanosleep(&req_ts, NULL);
  }
}

static void append_worker_json(StrBuf *sb) {
  refresh_worker_state();
  sb_append_fmt(sb, "\"worker\":{\"pid\":%d,\"uid\":%u,\"gid\":%u,\"cgroup\":",
                (int)g_worker.pid, (unsigned int)g_worker.uid, (unsigned int)g_worker.gid);
  sb_append_json_cstr(sb, g_worker.cgroup);
  sb_append_char(sb, '}');
}

/* A hidden staging entry that every failure response removes, so a refused archive operation leaves no trace. */
static struct {
  bool active;
  int parent_fd;
  char name[NAME_MAX + 1];
} g_staging;

static void discard_tree_at(int parent_fd, const char *name, int depth);

/* A worker killed at its timeout cannot clean up. Workers live 120 s at most, so an hour-old staging entry has no owner. */
#define XP_STALE_STAGING_SECONDS 3600
static void sweep_stale_staging(int parent_fd, const char *name) {
  struct stat st;
  if (fstatat(parent_fd, name, &st, AT_SYMLINK_NOFOLLOW) == 0 && time(NULL) - st.st_mtime >= XP_STALE_STAGING_SECONDS) discard_tree_at(parent_fd, name, 0);
}

/* reason is an optional stable machine code for a refusal that the error code alone does not name. */
static void respond_failure(const char *code, int err_num, const char *reason, const char *msg) __attribute__((noreturn));
static void respond_failure(const char *code, int err_num, const char *reason, const char *msg) {
  if (g_staging.active) {
    g_staging.active = false;
    discard_tree_at(g_staging.parent_fd, g_staging.name, 0);
  }
  StrBuf sb;
  sb_init(&sb, 512);
  sb_append_fmt(&sb, "{\"protocolVersion\":%d,\"ok\":false,\"op\":", XP_PROTOCOL_VERSION);
  sb_append_json_cstr(&sb, g_worker.op[0] ? g_worker.op : "unknown");
  sb_append_char(&sb, ',');
  append_worker_json(&sb);
  sb_append_str(&sb, ",\"error\":{\"code\":");
  sb_append_json_cstr(&sb, code);
  sb_append_fmt(&sb, ",\"errno\":%d,\"errnoName\":", err_num);
  sb_append_json_cstr(&sb, errno_to_name(err_num));
  sb_append_str(&sb, ",\"message\":");
  sb_append_json_cstr(&sb, msg);
  if (reason) {
    sb_append_str(&sb, ",\"reason\":");
    sb_append_json_cstr(&sb, reason);
  }
  sb_append_str(&sb, "}}\n");
  write_all_stdout(sb.data, sb.len);
  free(sb.data);
  maybe_hold_open();
  _exit(0);
}

static void respond_error(const char *code, int err_num, const char *msg) __attribute__((noreturn));
static void respond_error(const char *code, int err_num, const char *msg) {
  respond_failure(code, err_num, NULL, msg);
}

static void respond_errno(int err_num, const char *prefix) __attribute__((noreturn));
static void respond_errno(int err_num, const char *prefix) {
  char msg[512];
  snprintf(msg, sizeof(msg), "%s: %s (%s)", prefix, strerror(err_num), errno_to_name(err_num));
  respond_error(errno_to_xpanel_code(err_num), err_num, msg);
}

static void respond_success_raw(const char *result_json) __attribute__((noreturn));
static void respond_success_raw(const char *result_json) {
  StrBuf sb;
  sb_init(&sb, strlen(result_json) + 256);
  sb_append_fmt(&sb, "{\"protocolVersion\":%d,\"ok\":true,\"op\":", XP_PROTOCOL_VERSION);
  sb_append_json_cstr(&sb, g_worker.op);
  sb_append_char(&sb, ',');
  append_worker_json(&sb);
  sb_append_str(&sb, ",\"result\":");
  sb_append_str(&sb, result_json);
  sb_append_str(&sb, "}\n");
  write_all_stdout(sb.data, sb.len);
  free(sb.data);
  maybe_hold_open();
  _exit(0);
}

/* --- Minimal strict recursive-descent JSON parser --- */

typedef enum {
  JV_NULL,
  JV_BOOL,
  JV_NUMBER,
  JV_STRING,
  JV_OBJECT,
  JV_ARRAY
} JsonKind;

typedef struct JsonVal JsonVal;
typedef struct {
  char *key;
  JsonVal *val;
} JsonProp;

struct JsonVal {
  JsonKind kind;
  bool bool_val;
  int64_t int_val;
  char *str_val;
  size_t str_len;
  /* Object members; an array keeps its items here in order with a NULL key. */
  JsonProp *props;
  size_t prop_count;
};

typedef struct {
  const char *src;
  size_t len;
  size_t pos;
} JsonParser;

static void jp_skip_ws(JsonParser *p) {
  while (p->pos < p->len) {
    char c = p->src[p->pos];
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') p->pos++;
    else break;
  }
}

static int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static bool parse_u16(JsonParser *p, uint16_t *out) {
  if (p->pos + 4 > p->len) return false;
  uint16_t v = 0;
  for (int i = 0; i < 4; i++) {
    int h = hex_val(p->src[p->pos++]);
    if (h < 0) return false;
    v = (uint16_t)((v << 4) | (uint16_t)h);
  }
  *out = v;
  return true;
}

static void append_utf8_codepoint(StrBuf *sb, uint32_t cp) {
  if (cp <= 0x7F) {
    sb_append_char(sb, (char)cp);
  } else if (cp <= 0x7FF) {
    sb_append_char(sb, (char)(0xC0 | ((cp >> 6) & 0x1F)));
    sb_append_char(sb, (char)(0x80 | (cp & 0x3F)));
  } else if (cp <= 0xFFFF) {
    sb_append_char(sb, (char)(0xE0 | ((cp >> 12) & 0x0F)));
    sb_append_char(sb, (char)(0x80 | ((cp >> 6) & 0x3F)));
    sb_append_char(sb, (char)(0x80 | (cp & 0x3F)));
  } else if (cp <= 0x10FFFF) {
    sb_append_char(sb, (char)(0xF0 | ((cp >> 18) & 0x07)));
    sb_append_char(sb, (char)(0x80 | ((cp >> 12) & 0x3F)));
    sb_append_char(sb, (char)(0x80 | ((cp >> 6) & 0x3F)));
    sb_append_char(sb, (char)(0x80 | (cp & 0x3F)));
  }
}

static bool jp_parse_string(JsonParser *p, char **out_str, size_t *out_len) {
  if (p->pos >= p->len || p->src[p->pos] != '"') return false;
  p->pos++;
  StrBuf sb;
  sb_init(&sb, 64);
  while (p->pos < p->len) {
    unsigned char c = (unsigned char)p->src[p->pos++];
    if (c == '"') {
      *out_str = sb.data;
      *out_len = sb.len;
      return true;
    }
    if (c < 0x20) {
      free(sb.data);
      return false;
    }
    if (c != '\\') {
      sb_append_char(&sb, (char)c);
      continue;
    }
    if (p->pos >= p->len) {
      free(sb.data);
      return false;
    }
    char esc = p->src[p->pos++];
    switch (esc) {
      case '"': sb_append_char(&sb, '"'); break;
      case '\\': sb_append_char(&sb, '\\'); break;
      case '/': sb_append_char(&sb, '/'); break;
      case 'b': sb_append_char(&sb, '\b'); break;
      case 'f': sb_append_char(&sb, '\f'); break;
      case 'n': sb_append_char(&sb, '\n'); break;
      case 'r': sb_append_char(&sb, '\r'); break;
      case 't': sb_append_char(&sb, '\t'); break;
      case 'u': {
        uint16_t u1 = 0;
        if (!parse_u16(p, &u1)) {
          free(sb.data);
          return false;
        }
        uint32_t cp = u1;
        if (u1 >= 0xD800 && u1 <= 0xDBFF) {
          if (p->pos + 2 > p->len || p->src[p->pos] != '\\' || p->src[p->pos + 1] != 'u') {
            free(sb.data);
            return false;
          }
          p->pos += 2;
          uint16_t u2 = 0;
          if (!parse_u16(p, &u2) || u2 < 0xDC00 || u2 > 0xDFFF) {
            free(sb.data);
            return false;
          }
          cp = 0x10000U + (((uint32_t)(u1 - 0xD800U) << 10) | (uint32_t)(u2 - 0xDC00U));
        } else if (u1 >= 0xDC00 && u1 <= 0xDFFF) {
          free(sb.data);
          return false;
        }
        append_utf8_codepoint(&sb, cp);
        break;
      }
      default:
        free(sb.data);
        return false;
    }
  }
  free(sb.data);
  return false;
}

static JsonVal *jp_parse_value(JsonParser *p, int depth);

static JsonVal *jp_parse_object(JsonParser *p, int depth) {
  if (depth > 8 || p->pos >= p->len || p->src[p->pos] != '{') return NULL;
  p->pos++;
  JsonVal *v = calloc(1, sizeof(JsonVal));
  if (!v) _exit(12);
  v->kind = JV_OBJECT;
  size_t cap = 8;
  v->props = calloc(cap, sizeof(JsonProp));
  if (!v->props) _exit(12);

  jp_skip_ws(p);
  if (p->pos < p->len && p->src[p->pos] == '}') {
    p->pos++;
    return v;
  }
  while (p->pos < p->len) {
    jp_skip_ws(p);
    char *key = NULL;
    size_t key_len = 0;
    if (!jp_parse_string(p, &key, &key_len)) return NULL;
    jp_skip_ws(p);
    if (p->pos >= p->len || p->src[p->pos] != ':') return NULL;
    p->pos++;
    jp_skip_ws(p);
    JsonVal *child = jp_parse_value(p, depth + 1);
    if (!child) return NULL;
    if (v->prop_count == cap) {
      cap *= 2;
      JsonProp *np = realloc(v->props, cap * sizeof(JsonProp));
      if (!np) _exit(12);
      v->props = np;
    }
    v->props[v->prop_count].key = key;
    v->props[v->prop_count].val = child;
    v->prop_count++;
    jp_skip_ws(p);
    if (p->pos < p->len && p->src[p->pos] == ',') {
      p->pos++;
      continue;
    }
    if (p->pos < p->len && p->src[p->pos] == '}') {
      p->pos++;
      return v;
    }
    return NULL;
  }
  return NULL;
}

static JsonVal *jp_parse_array(JsonParser *p, int depth) {
  if (depth > 8 || p->pos >= p->len || p->src[p->pos] != '[') return NULL;
  p->pos++;
  JsonVal *v = calloc(1, sizeof(JsonVal));
  if (!v) _exit(12);
  v->kind = JV_ARRAY;
  size_t cap = 8;
  v->props = calloc(cap, sizeof(JsonProp));
  if (!v->props) _exit(12);

  jp_skip_ws(p);
  if (p->pos < p->len && p->src[p->pos] == ']') {
    p->pos++;
    return v;
  }
  while (p->pos < p->len) {
    JsonVal *child = jp_parse_value(p, depth + 1);
    if (!child) return NULL;
    if (v->prop_count == cap) {
      cap *= 2;
      JsonProp *np = realloc(v->props, cap * sizeof(JsonProp));
      if (!np) _exit(12);
      v->props = np;
    }
    v->props[v->prop_count].key = NULL;
    v->props[v->prop_count].val = child;
    v->prop_count++;
    jp_skip_ws(p);
    if (p->pos < p->len && p->src[p->pos] == ',') {
      p->pos++;
      continue;
    }
    if (p->pos < p->len && p->src[p->pos] == ']') {
      p->pos++;
      return v;
    }
    return NULL;
  }
  return NULL;
}

static JsonVal *jp_parse_value(JsonParser *p, int depth) {
  if (depth > 8) return NULL;
  jp_skip_ws(p);
  if (p->pos >= p->len) return NULL;
  char c = p->src[p->pos];
  if (c == '{') return jp_parse_object(p, depth);
  if (c == '[') return jp_parse_array(p, depth);
  if (c == '"') {
    JsonVal *v = calloc(1, sizeof(JsonVal));
    if (!v) _exit(12);
    v->kind = JV_STRING;
    if (!jp_parse_string(p, &v->str_val, &v->str_len)) return NULL;
    return v;
  }
  if (c == 't' && p->pos + 4 <= p->len && memcmp(p->src + p->pos, "true", 4) == 0) {
    p->pos += 4;
    JsonVal *v = calloc(1, sizeof(JsonVal));
    if (!v) _exit(12);
    v->kind = JV_BOOL;
    v->bool_val = true;
    return v;
  }
  if (c == 'f' && p->pos + 5 <= p->len && memcmp(p->src + p->pos, "false", 5) == 0) {
    p->pos += 5;
    JsonVal *v = calloc(1, sizeof(JsonVal));
    if (!v) _exit(12);
    v->kind = JV_BOOL;
    v->bool_val = false;
    return v;
  }
  if (c == 'n' && p->pos + 4 <= p->len && memcmp(p->src + p->pos, "null", 4) == 0) {
    p->pos += 4;
    JsonVal *v = calloc(1, sizeof(JsonVal));
    if (!v) _exit(12);
    v->kind = JV_NULL;
    return v;
  }
  if (c == '-' || (c >= '0' && c <= '9')) {
    size_t start = p->pos;
    if (p->src[p->pos] == '-') p->pos++;
    if (p->pos >= p->len || p->src[p->pos] < '0' || p->src[p->pos] > '9') return NULL;
    while (p->pos < p->len && p->src[p->pos] >= '0' && p->src[p->pos] <= '9') p->pos++;
    if (p->pos < p->len && (p->src[p->pos] == '.' || p->src[p->pos] == 'e' || p->src[p->pos] == 'E')) {
      return NULL;
    }
    char numbuf[64];
    size_t nlen = p->pos - start;
    if (nlen == 0 || nlen >= sizeof(numbuf)) return NULL;
    memcpy(numbuf, p->src + start, nlen);
    numbuf[nlen] = '\0';
    errno = 0;
    char *endp = NULL;
    long long parsed = strtoll(numbuf, &endp, 10);
    if (errno != 0 || !endp || *endp != '\0') return NULL;
    JsonVal *v = calloc(1, sizeof(JsonVal));
    if (!v) _exit(12);
    v->kind = JV_NUMBER;
    v->int_val = (int64_t)parsed;
    return v;
  }
  return NULL;
}

static const JsonVal *jv_get(const JsonVal *obj, const char *key) {
  if (!obj || obj->kind != JV_OBJECT) return NULL;
  for (size_t i = 0; i < obj->prop_count; i++) {
    if (strcmp(obj->props[i].key, key) == 0) return obj->props[i].val;
  }
  return NULL;
}

static bool jv_get_str(const JsonVal *obj, const char *key, const char **out_str, size_t *out_len) {
  const JsonVal *v = jv_get(obj, key);
  if (!v || v->kind != JV_STRING) return false;
  *out_str = v->str_val;
  if (out_len) *out_len = v->str_len;
  return true;
}

static bool jv_get_int(const JsonVal *obj, const char *key, int64_t *out_val) {
  const JsonVal *v = jv_get(obj, key);
  if (!v || v->kind != JV_NUMBER) return false;
  *out_val = v->int_val;
  return true;
}

static bool jv_get_bool(const JsonVal *obj, const char *key, bool *out_val) {
  const JsonVal *v = jv_get(obj, key);
  if (!v || v->kind != JV_BOOL) return false;
  *out_val = v->bool_val;
  return true;
}

/* --- UTF-8 validation --- */

static bool is_valid_utf8(const char *s, size_t len) {
  const unsigned char *bytes = (const unsigned char *)s;
  size_t i = 0;
  while (i < len) {
    unsigned char b0 = bytes[i];
    if (b0 <= 0x7F) {
      i++;
      continue;
    }
    if (b0 >= 0xC2 && b0 <= 0xDF) {
      if (i + 1 >= len) return false;
      if ((bytes[i + 1] & 0xC0) != 0x80) return false;
      i += 2;
      continue;
    }
    if (b0 >= 0xE0 && b0 <= 0xEF) {
      if (i + 2 >= len) return false;
      unsigned char b1 = bytes[i + 1];
      unsigned char b2 = bytes[i + 2];
      if ((b1 & 0xC0) != 0x80 || (b2 & 0xC0) != 0x80) return false;
      if (b0 == 0xE0 && b1 < 0xA0) return false;
      if (b0 == 0xED && b1 >= 0xA0) return false; /* UTF-16 surrogates */
      i += 3;
      continue;
    }
    if (b0 >= 0xF0 && b0 <= 0xF4) {
      if (i + 3 >= len) return false;
      unsigned char b1 = bytes[i + 1];
      unsigned char b2 = bytes[i + 2];
      unsigned char b3 = bytes[i + 3];
      if ((b1 & 0xC0) != 0x80 || (b2 & 0xC0) != 0x80 || (b3 & 0xC0) != 0x80) return false;
      if (b0 == 0xF0 && b1 < 0x90) return false;
      if (b0 == 0xF4 && b1 >= 0x90) return false;
      i += 4;
      continue;
    }
    return false;
  }
  return true;
}

/* --- Syscall helpers --- */

static void close_extra_fds(void) {
  if (syscall(SYS_close_range, 3U, ~0U, 0U) == 0) return;
  for (int fd = 3; fd < 1024; fd++) close(fd);
}

static int xp_openat2(int dirfd, const char *path, uint64_t flags, uint64_t mode, uint64_t resolve) {
  struct open_how how;
  memset(&how, 0, sizeof(how));
  how.flags = flags | O_CLOEXEC;
  how.mode = (flags & O_CREAT) ? mode : 0;
  how.resolve = resolve;
  for (int attempt = 0; attempt < 4; attempt++) {
    long ret = syscall(SYS_openat2, dirfd, path, &how, sizeof(how));
    if (ret >= 0) return (int)ret;
    if (errno != EAGAIN) return -1;
  }
  return -1;
}

static int xp_renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags) {
  return (int)syscall(SYS_renameat2, olddirfd, oldpath, newdirfd, newpath, flags);
}

static void format_iso8601_utc(const struct timespec *ts, char out[32]) {
  struct tm tm_utc;
  memset(&tm_utc, 0, sizeof(tm_utc));
  gmtime_r(&ts->tv_sec, &tm_utc);
  unsigned int year = (unsigned int)((tm_utc.tm_year + 1900) > 0 ? (tm_utc.tm_year + 1900) : 1970) % 10000U;
  unsigned int mon = (unsigned int)((tm_utc.tm_mon + 1) > 0 ? (tm_utc.tm_mon + 1) : 1) % 100U;
  unsigned int mday = (unsigned int)(tm_utc.tm_mday > 0 ? tm_utc.tm_mday : 1) % 100U;
  unsigned int hour = (unsigned int)(tm_utc.tm_hour >= 0 ? tm_utc.tm_hour : 0) % 100U;
  unsigned int min = (unsigned int)(tm_utc.tm_min >= 0 ? tm_utc.tm_min : 0) % 100U;
  unsigned int sec = (unsigned int)(tm_utc.tm_sec >= 0 ? tm_utc.tm_sec : 0) % 100U;
  unsigned int ms = (unsigned int)((ts->tv_nsec >= 0 ? (ts->tv_nsec / 1000000L) : 0L) % 1000L);
  snprintf(out, 32, "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
           year, mon, mday, hour, min, sec, ms);
}

static bool validate_uuid_v4(const char *s) {
  if (!s || strlen(s) != 36) return false;
  for (int i = 0; i < 36; i++) {
    char c = s[i];
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (c != '-') return false;
      continue;
    }
    if (i == 14) {
      if (c != '4') return false;
      continue;
    }
    if (i == 19) {
      if (c != '8' && c != '9' && c != 'a' && c != 'b' && c != 'A' && c != 'B') return false;
      continue;
    }
    if (hex_val(c) < 0) return false;
  }
  return true;
}

static void generate_uuid_v4(char out[37]) {
  uint8_t bytes[16];
  if (getrandom(bytes, sizeof(bytes), 0) != (ssize_t)sizeof(bytes)) {
    respond_errno(errno ? errno : EIO, "getrandom failed");
  }
  bytes[6] = (uint8_t)((bytes[6] & 0x0F) | 0x40);
  bytes[8] = (uint8_t)((bytes[8] & 0x3F) | 0x80);
  snprintf(out, 37,
           "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
           bytes[0], bytes[1], bytes[2], bytes[3],
           bytes[4], bytes[5], bytes[6], bytes[7],
           bytes[8], bytes[9], bytes[10], bytes[11],
           bytes[12], bytes[13], bytes[14], bytes[15]);
}

static void generate_random_hex(char out[17]) {
  uint8_t bytes[8];
  if (getrandom(bytes, sizeof(bytes), 0) != (ssize_t)sizeof(bytes)) {
    respond_errno(errno ? errno : EIO, "getrandom failed");
  }
  for (int i = 0; i < 8; i++) {
    snprintf(out + (i * 2), 3, "%02x", bytes[i]);
  }
}

/* --- Path validation and splitting --- */

static void assert_safe_rel_path(const char *path, size_t len, bool allow_empty) {
  if (!is_valid_utf8(path, len) || len > XP_MAX_PATH_BYTES) {
    respond_error("VALIDATION", EINVAL, "invalid account-relative path");
  }
  if (len == 0) {
    if (allow_empty) return;
    respond_error("VALIDATION", EINVAL, "path is required");
  }
  if (path[0] == '/' || (len >= 2 && isalpha((unsigned char)path[0]) && path[1] == ':')) {
    respond_error("FORBIDDEN", EACCES, "path must be relative to the account home");
  }
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)path[i];
    if (c < 0x20 || c == 0x7f || c == '\\') {
      respond_error("FORBIDDEN", EACCES, "path must be relative to the account home");
    }
  }
  size_t seg_start = 0;
  for (size_t i = 0; i <= len; i++) {
    if (i == len || path[i] == '/') {
      size_t seg_len = i - seg_start;
      if (seg_len == 0 ||
          (seg_len == 1 && path[seg_start] == '.') ||
          (seg_len == 2 && path[seg_start] == '.' && path[seg_start + 1] == '.')) {
        respond_error("FORBIDDEN", EACCES, "path traversal outside the account home is forbidden");
      }
      seg_start = i + 1;
    }
  }
  if (strcmp(path, ".trash") == 0 || strncmp(path, ".trash/", 7) == 0) {
    respond_error("FORBIDDEN", EACCES, "trash contents are accessible only through trash operations");
  }
}

static void split_rel_path(const char *path, char parent_out[XP_MAX_PATH_BYTES + 1], char name_out[NAME_MAX + 1]) {
  const char *slash = strrchr(path, '/');
  if (!slash) {
    snprintf(parent_out, XP_MAX_PATH_BYTES + 1, ".");
    if (strlen(path) > NAME_MAX) respond_error("VALIDATION", ENAMETOOLONG, "file name exceeds NAME_MAX");
    snprintf(name_out, NAME_MAX + 1, "%s", path);
    return;
  }
  size_t plen = (size_t)(slash - path);
  const char *bname = slash + 1;
  if (plen == 0 || plen > XP_MAX_PATH_BYTES || strlen(bname) == 0 || strlen(bname) > NAME_MAX) {
    respond_error("VALIDATION", EINVAL, "invalid path segment length");
  }
  memcpy(parent_out, path, plen);
  parent_out[plen] = '\0';
  snprintf(name_out, NAME_MAX + 1, "%s", bname);
}

static int open_confined_dir(int home_dirfd, const char *rel_dir, uid_t expected_uid) {
  int fd = -1;
  if (!rel_dir || rel_dir[0] == '\0' || strcmp(rel_dir, ".") == 0) {
    fd = fcntl(home_dirfd, F_DUPFD_CLOEXEC, 3);
    if (fd < 0) respond_errno(errno, "dup home_dirfd failed");
  } else {
    fd = xp_openat2(home_dirfd, rel_dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0, XP_RESOLVE_CONFINED);
    if (fd < 0) {
      int err = errno;
      if (err == ENOTDIR) {
        struct stat lst;
        if (fstatat(home_dirfd, rel_dir, &lst, AT_SYMLINK_NOFOLLOW) == 0 && S_ISLNK(lst.st_mode)) {
          err = ELOOP;
        }
      }
      respond_errno(err, "openat2 directory failed");
    }
  }
  struct stat st;
  if (fstat(fd, &st) != 0) {
    int err = errno;
    close(fd);
    respond_errno(err, "fstat directory failed");
  }
  if (!S_ISDIR(st.st_mode)) {
    close(fd);
    respond_error("NOT_FOUND", ENOTDIR, "target path is not a directory");
  }
  if (st.st_uid != expected_uid) {
    close(fd);
    respond_error("FORBIDDEN", EACCES, "directory owner UID does not match account UID");
  }
  return fd;
}

static void append_file_entry_json(StrBuf *sb, const char *name, const char *rel_path, const char *kind,
                                   int64_t size_bytes, mode_t mode, const struct timespec *mtime_ts) {
  char mtime[32];
  format_iso8601_utc(mtime_ts, mtime);
  sb_append_str(sb, "{\"name\":");
  sb_append_json_cstr(sb, name);
  sb_append_str(sb, ",\"path\":");
  sb_append_json_cstr(sb, rel_path);
  sb_append_str(sb, ",\"kind\":");
  sb_append_json_cstr(sb, kind);
  sb_append_fmt(sb, ",\"sizeBytes\":%" PRId64 ",\"mode\":%u,\"mtime\":",
                size_bytes, (unsigned int)(mode & 07777));
  sb_append_json_cstr(sb, mtime);
  sb_append_char(sb, '}');
}

/* --- Supervisor setup: root chain, cgroup v2, privilege drop --- */

static int open_and_verify_home_root(const char *home_root, uid_t account_uid, gid_t account_gid) {
  size_t len = strlen(home_root);
  if (len < 2 || home_root[0] != '/' || home_root[len - 1] == '/') {
    respond_error("VALIDATION", EINVAL, "homeRoot must be a canonical absolute path");
  }
  const char *slash = strrchr(home_root, '/');
  if (!slash || slash == home_root) {
    respond_error("FORBIDDEN", EACCES, "homeRoot must reside under a root-owned parent directory");
  }
  char parent_path[XP_MAX_PATH_BYTES + 1];
  size_t plen = (size_t)(slash - home_root);
  if (plen >= sizeof(parent_path)) respond_error("VALIDATION", ENAMETOOLONG, "homeRoot parent too long");
  memcpy(parent_path, home_root, plen);
  parent_path[plen] = '\0';
  const char *home_leaf = slash + 1;

  struct stat parent_lst;
  if (lstat(parent_path, &parent_lst) != 0) {
    respond_errno(errno, "lstat homeRoot parent failed");
  }
  if (S_ISLNK(parent_lst.st_mode) || !S_ISDIR(parent_lst.st_mode)) {
    respond_error("FORBIDDEN", EACCES, "homeRoot parent must be a real directory, not a symlink");
  }
  int parent_fd = open(parent_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (parent_fd < 0) {
    respond_errno(errno, "open homeRoot parent failed");
  }
  struct stat parent_st;
  if (fstat(parent_fd, &parent_st) != 0) {
    int err = errno;
    close(parent_fd);
    respond_errno(err, "fstat homeRoot parent failed");
  }
  if (!S_ISDIR(parent_st.st_mode) || parent_st.st_uid != 0 || parent_st.st_gid != 0 || (parent_st.st_mode & 0022) != 0) {
    close(parent_fd);
    respond_error("FORBIDDEN", EACCES, "homeRoot parent must be owned by root:root without group or world write access");
  }

  int home_fd = xp_openat2(parent_fd, home_leaf, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0, XP_RESOLVE_CONFINED);
  int open_err = errno;
  close(parent_fd);
  if (home_fd < 0) {
    if (open_err == ENOSYS) {
      respond_error("PRECONDITION_FAILED", ENOSYS, "kernel openat2 support is required for confined file operations");
    }
    respond_errno(open_err, "openat2 account homeRoot failed");
  }

  struct stat home_st;
  if (fstat(home_fd, &home_st) != 0) {
    int err = errno;
    close(home_fd);
    respond_errno(err, "fstat account homeRoot failed");
  }
  if (!S_ISDIR(home_st.st_mode)) {
    close(home_fd);
    respond_error("FORBIDDEN", ENOTDIR, "account homeRoot is not a directory");
  }
  if (home_st.st_uid != account_uid || home_st.st_gid != account_gid) {
    close(home_fd);
    respond_error("FORBIDDEN", EACCES, "account homeRoot ownership does not match account UID/GID");
  }
  if ((home_st.st_mode & 0027) != 0) {
    close(home_fd);
    respond_error("FORBIDDEN", EACCES, "account homeRoot permissions must be 0750 or stricter");
  }
  return home_fd;
}

static void require_root_owned_fd(int fd, bool directory, const char *message) {
  struct stat st;
  if (fstat(fd, &st) != 0 || (directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)) ||
      st.st_uid != 0 || st.st_gid != 0 || (st.st_mode & 0022) != 0) {
    respond_error("PRECONDITION_FAILED", EACCES, message);
  }
}

static int open_confined_cgroup_dir(int parent_fd, const char *name) {
  int fd = xp_openat2(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, 0, XP_RESOLVE_CONFINED);
  if (fd < 0) respond_error("PRECONDITION_FAILED", errno, "required account cgroup directory is unavailable");
  require_root_owned_fd(fd, true, "account cgroup directories must be root-owned and nondelegated");
  return fd;
}

static void read_cgroup_text_at(int parent_fd, const char *name, char *out, size_t cap) {
  int fd = xp_openat2(parent_fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC, 0, XP_RESOLVE_CONFINED);
  if (fd < 0) respond_error("PRECONDITION_FAILED", errno, "required cgroup controller interface is unavailable");
  require_root_owned_fd(fd, false, "cgroup controller interfaces must be root-owned and nondelegated");
  size_t used = 0;
  while (used < cap - 1) {
    ssize_t n = read(fd, out + used, cap - 1 - used);
    if (n < 0) { if (errno == EINTR) continue; respond_error("PRECONDITION_FAILED", errno, "cgroup controller interface read failed"); }
    if (n == 0) break;
    used += (size_t)n;
  }
  if (used == cap - 1) {
    char extra;
    ssize_t n;
    do { n = read(fd, &extra, 1); } while (n < 0 && errno == EINTR);
    if (n != 0) respond_error("PRECONDITION_FAILED", EOVERFLOW, "cgroup controller interface exceeded the bounded read");
  }
  close(fd);
  out[used] = '\0';
  while (used > 0 && (out[used - 1] == '\n' || out[used - 1] == '\r')) out[--used] = '\0';
}

static bool positive_decimal(const char *value) {
  if (!value || !value[0]) return false;
  for (const char *p = value; *p; p++) if (*p < '0' || *p > '9') return false;
  errno = 0;
  char *end = NULL;
  unsigned long long parsed = strtoull(value, &end, 10);
  return errno == 0 && end && *end == '\0' && parsed > 0;
}

static bool valid_cpu_max(const char *value, bool worker_budget) {
  char quota[32], period[32], extra;
  if (sscanf(value, "%31s %31s %c", quota, period, &extra) != 2 || !positive_decimal(period)) return false;
  if (strcmp(quota, "max") == 0) return !worker_budget;
  if (!positive_decimal(quota)) return false;
  if (!worker_budget) return true;
  return strtoull(quota, NULL, 10) <= strtoull(period, NULL, 10);
}

static void verify_controller_contract(int parent_fd, int leaf_fd) {
  char value[4096];
  read_cgroup_text_at(parent_fd, "cgroup.type", value, sizeof(value));
  if (strcmp(value, "domain") != 0) respond_error("PRECONDITION_FAILED", EINVAL, "account cgroup must be a valid domain");
  read_cgroup_text_at(parent_fd, "memory.max", value, sizeof(value));
  if (strcmp(value, "max") != 0 && !positive_decimal(value)) respond_error("PRECONDITION_FAILED", EINVAL, "invalid account memory controller contract");
  read_cgroup_text_at(parent_fd, "pids.max", value, sizeof(value));
  if (strcmp(value, "max") != 0 && !positive_decimal(value)) respond_error("PRECONDITION_FAILED", EINVAL, "invalid account pids controller contract");
  read_cgroup_text_at(parent_fd, "cpu.max", value, sizeof(value));
  if (!valid_cpu_max(value, false)) respond_error("PRECONDITION_FAILED", EINVAL, "invalid account CPU controller contract");
  read_cgroup_text_at(parent_fd, "io.max", value, sizeof(value));

  read_cgroup_text_at(leaf_fd, "cgroup.type", value, sizeof(value));
  if (strcmp(value, "domain") != 0) respond_error("PRECONDITION_FAILED", EINVAL, "file worker cgroup must be a valid domain leaf");
  read_cgroup_text_at(leaf_fd, "cgroup.subtree_control", value, sizeof(value));
  if (value[0] != '\0') respond_error("PRECONDITION_FAILED", EINVAL, "file worker cgroup cannot distribute controllers to children");
  read_cgroup_text_at(leaf_fd, "memory.max", value, sizeof(value));
  if (strcmp(value, "67108864") != 0) respond_error("PRECONDITION_FAILED", EINVAL, "file worker memory safety budget is not applied");
  read_cgroup_text_at(leaf_fd, "memory.swap.max", value, sizeof(value));
  if (strcmp(value, "0") != 0) respond_error("PRECONDITION_FAILED", EINVAL, "file worker swap safety budget is not applied");
  read_cgroup_text_at(leaf_fd, "pids.max", value, sizeof(value));
  if (strcmp(value, "1") != 0) respond_error("PRECONDITION_FAILED", EINVAL, "file worker process safety budget is not applied");
  read_cgroup_text_at(leaf_fd, "cpu.max", value, sizeof(value));
  if (!valid_cpu_max(value, true)) respond_error("PRECONDITION_FAILED", EINVAL, "file worker CPU safety budget is not applied");

  int scan_fd = dup(leaf_fd);
  if (scan_fd < 0) respond_error("PRECONDITION_FAILED", errno, "file worker leaf inspection failed");
  DIR *dirp = fdopendir(scan_fd);
  if (!dirp) { close(scan_fd); respond_error("PRECONDITION_FAILED", errno, "file worker leaf inspection failed"); }
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(dirp)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    struct stat st;
    if (fstatat(dirfd(dirp), entry->d_name, &st, AT_SYMLINK_NOFOLLOW) != 0 || S_ISDIR(st.st_mode) || S_ISLNK(st.st_mode)) {
      closedir(dirp);
      respond_error("PRECONDITION_FAILED", EINVAL, "file worker must occupy a nondelegated leaf without child cgroups");
    }
    errno = 0;
  }
  int scan_error = errno;
  closedir(dirp);
  if (scan_error) respond_error("PRECONDITION_FAILED", scan_error, "file worker leaf inspection failed");
}

static void verify_account_cgroup(const char *cgroup_path, const char *worker_unit, uid_t account_uid) {
  char expected_parent[160], unit_prefix[80], account_name[64];
  snprintf(account_name, sizeof(account_name), "xpanel-%u.slice", (unsigned int)account_uid);
  snprintf(expected_parent, sizeof(expected_parent), "/sys/fs/cgroup/xpanel.slice/%s", account_name);
  snprintf(unit_prefix, sizeof(unit_prefix), "xpanel-files-%u-", (unsigned int)account_uid);
  size_t prefix_len = strlen(unit_prefix);
  if (strcmp(cgroup_path, expected_parent) != 0 ||
      strncmp(worker_unit, unit_prefix, prefix_len) != 0 || strlen(worker_unit) != prefix_len + 32 + strlen(".service") ||
      strcmp(worker_unit + prefix_len + 32, ".service") != 0) {
    respond_error("VALIDATION", EINVAL, "file worker identity must match the canonical account UID slice and generated service");
  }
  for (size_t i = prefix_len; i < prefix_len + 32; i++) {
    if (!((worker_unit[i] >= '0' && worker_unit[i] <= '9') || (worker_unit[i] >= 'a' && worker_unit[i] <= 'f'))) {
      respond_error("VALIDATION", EINVAL, "file worker service identifier is invalid");
    }
  }

  int etc_fd = open("/etc", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (etc_fd < 0) respond_error("PRECONDITION_FAILED", errno, "account unit policy directory is unavailable");
  require_root_owned_fd(etc_fd, true, "account unit policy directory must be root-owned and nondelegated");
  int systemd_fd = xp_openat2(etc_fd, "systemd", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, 0, XP_RESOLVE_CONFINED);
  close(etc_fd);
  if (systemd_fd < 0) respond_error("PRECONDITION_FAILED", errno, "account unit policy directory is unavailable");
  require_root_owned_fd(systemd_fd, true, "account unit policy ancestors must be root-owned and nondelegated");
  int policy_dir_fd = xp_openat2(systemd_fd, "system", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, 0, XP_RESOLVE_CONFINED);
  close(systemd_fd);
  if (policy_dir_fd < 0) respond_error("PRECONDITION_FAILED", errno, "account unit policy directory is unavailable");
  require_root_owned_fd(policy_dir_fd, true, "account unit policy directory must be root-owned and nondelegated");
  int policy_fd = xp_openat2(policy_dir_fd, account_name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC, 0, XP_RESOLVE_CONFINED);
  close(policy_dir_fd);
  if (policy_fd < 0) respond_error("PRECONDITION_FAILED", errno, "provisioned account slice policy is required");
  require_root_owned_fd(policy_fd, false, "account slice policy must be root-owned and nondelegated");

  int mount_fd = open("/sys/fs/cgroup", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (mount_fd < 0) respond_error("PRECONDITION_FAILED", errno, "cgroup v2 mount is unavailable");
  struct statfs mount_info;
  if (fstatfs(mount_fd, &mount_info) != 0 || (unsigned long)mount_info.f_type != (unsigned long)CGROUP2_SUPER_MAGIC) {
    respond_error("PRECONDITION_FAILED", EINVAL, "native file workers require the unified cgroup v2 mount");
  }
  require_root_owned_fd(mount_fd, true, "cgroup mount must be root-owned and nondelegated");
  int xpanel_fd = open_confined_cgroup_dir(mount_fd, "xpanel.slice");
  int parent_fd = open_confined_cgroup_dir(xpanel_fd, account_name);
  int leaf_fd = open_confined_cgroup_dir(parent_fd, worker_unit);
  verify_controller_contract(parent_fd, leaf_fd);
  char expected_membership[512], actual_membership[512];
  int expected_len = snprintf(expected_membership, sizeof(expected_membership), "%s/%s", expected_parent + strlen("/sys/fs/cgroup"), worker_unit);
  if (expected_len < 0 || (size_t)expected_len >= sizeof(expected_membership) ||
      !read_self_cgroup(actual_membership) || strcmp(actual_membership, expected_membership) != 0) {
    respond_error("PRECONDITION_FAILED", EPERM, "file worker is not in its exact systemd account service cgroup");
  }
  snprintf(g_worker.cgroup, sizeof(g_worker.cgroup), "%s", actual_membership);
  close(leaf_fd);
  close(parent_fd);
  close(xpanel_fd);
  close(mount_fd);
  close(policy_fd);
}

static void drop_privileges_irreversibly(int home_dirfd, uid_t uid, gid_t gid) {
  umask(0027);
  if (fchdir(home_dirfd) != 0) {
    respond_errno(errno, "fchdir to home_dirfd failed");
  }
  if (setgroups(0, NULL) != 0) {
    respond_errno(errno, "setgroups(0, NULL) failed");
  }
  if (setresgid(gid, gid, gid) != 0) {
    respond_errno(errno, "setresgid failed");
  }
  if (setresuid(uid, uid, uid) != 0) {
    respond_errno(errno, "setresuid failed");
  }
  uid_t ruid = 0, euid = 0, suid = 0;
  gid_t rgid = 0, egid = 0, sgid = 0;
  if (getresuid(&ruid, &euid, &suid) != 0 || getresgid(&rgid, &egid, &sgid) != 0) {
    respond_errno(errno, "getresuid/getresgid verification failed");
  }
  if (ruid != uid || euid != uid || suid != uid || rgid != gid || egid != gid || sgid != gid) {
    respond_error("PRECONDITION_FAILED", EPERM, "privilege drop verification failed: UID/GID mismatch");
  }
  if (setuid(0) == 0 || seteuid(0) == 0) {
    _exit(1);
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    respond_errno(errno, "prctl(PR_SET_NO_NEW_PRIVS) failed");
  }
  (void)prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
  refresh_worker_state();
}

/* --- Operations --- */

typedef struct {
  char *name;
  char *path;
  char kind[16];
  int64_t size_bytes;
  mode_t mode;
  struct timespec mtime;
} DirEntryItem;

static int cmp_dir_entry(const void *a, const void *b) {
  const DirEntryItem *da = (const DirEntryItem *)a;
  const DirEntryItem *db = (const DirEntryItem *)b;
  return strcmp(da->name, db->name);
}

static void op_list(int home_dirfd, uid_t uid, const JsonVal *req, int64_t max_list_entries) {
  const char *path = "";
  size_t path_len = 0;
  if (!jv_get_str(req, "path", &path, &path_len)) {
    respond_error("VALIDATION", EINVAL, "list requires a string path");
  }
  bool show_hidden = true;
  if (!jv_get_bool(req, "showHidden", &show_hidden)) {
    respond_error("VALIDATION", EINVAL, "list requires boolean showHidden");
  }
  assert_safe_rel_path(path, path_len, true);

  int dir_fd = open_confined_dir(home_dirfd, path, uid);
  DIR *dirp = fdopendir(dir_fd);
  if (!dirp) {
    int err = errno;
    close(dir_fd);
    respond_errno(err, "fdopendir failed");
  }
  rewinddir(dirp);

  size_t count = 0;
  size_t cap = 32;
  DirEntryItem *items = calloc(cap, sizeof(DirEntryItem));
  if (!items) _exit(12);

  while (true) {
    errno = 0;
    struct dirent *de = readdir(dirp);
    if (!de) {
      if (errno != 0) {
        int err = errno;
        closedir(dirp);
        respond_errno(err, "readdir failed");
      }
      break;
    }
    const char *dname = de->d_name;
    if (strcmp(dname, ".") == 0 || strcmp(dname, "..") == 0) continue;
    if (path_len == 0 && strcmp(dname, ".trash") == 0) continue;
    if (strncmp(dname, ".xpanel-tmp-", 12) == 0) {
      sweep_stale_staging(dirfd(dirp), dname);
      continue;
    }
    if (!show_hidden && dname[0] == '.') continue;

    struct stat st;
    if (fstatat(dirfd(dirp), dname, &st, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT) continue;
      int err = errno;
      closedir(dirp);
      respond_errno(err, "fstatat directory child failed");
    }
    const char *kind = NULL;
    if (S_ISREG(st.st_mode)) kind = "file";
    else if (S_ISDIR(st.st_mode)) kind = "directory";
    else if (S_ISLNK(st.st_mode)) kind = "symlink";
    else continue;

    if ((int64_t)(count + 1) > max_list_entries) {
      closedir(dirp);
      respond_error("LIMIT_EXCEEDED", E2BIG, "directory entry count exceeds maxListEntries");
    }
    if (count == cap) {
      cap *= 2;
      DirEntryItem *ni = realloc(items, cap * sizeof(DirEntryItem));
      if (!ni) _exit(12);
      items = ni;
    }
    items[count].name = strdup(dname);
    size_t full_len = path_len ? (path_len + 1 + strlen(dname)) : strlen(dname);
    items[count].path = calloc(1, full_len + 1);
    if (!items[count].name || !items[count].path) _exit(12);
    if (path_len > 0) {
      snprintf(items[count].path, full_len + 1, "%s/%s", path, dname);
    } else {
      snprintf(items[count].path, full_len + 1, "%s", dname);
    }
    snprintf(items[count].kind, sizeof(items[count].kind), "%s", kind);
    items[count].size_bytes = S_ISREG(st.st_mode) ? (int64_t)st.st_size : 0;
    items[count].mode = st.st_mode & 07777;
    items[count].mtime = st.st_mtim;
    count++;
  }
  closedir(dirp);

  if (count > 1) {
    qsort(items, count, sizeof(DirEntryItem), cmp_dir_entry);
  }

  StrBuf sb;
  sb_init(&sb, 256 + count * 128);
  sb_append_char(&sb, '[');
  for (size_t i = 0; i < count; i++) {
    if (i > 0) sb_append_char(&sb, ',');
    append_file_entry_json(&sb, items[i].name, items[i].path, items[i].kind,
                           items[i].size_bytes, items[i].mode, &items[i].mtime);
  }
  sb_append_char(&sb, ']');
  respond_success_raw(sb.data);
}

static void op_read(int home_dirfd, uid_t uid, const JsonVal *req, int64_t max_edit_bytes) {
  const char *path = NULL;
  size_t path_len = 0;
  if (!jv_get_str(req, "path", &path, &path_len)) {
    respond_error("VALIDATION", EINVAL, "read requires a string path");
  }
  assert_safe_rel_path(path, path_len, false);

  int fd = xp_openat2(home_dirfd, path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK, 0, XP_RESOLVE_CONFINED);
  if (fd < 0) {
    respond_errno(errno, "openat2 read failed");
  }
  struct stat st;
  if (fstat(fd, &st) != 0) {
    int err = errno;
    close(fd);
    respond_errno(err, "fstat read failed");
  }
  if (!S_ISREG(st.st_mode)) {
    close(fd);
    respond_error("FORBIDDEN", EACCES, "only regular files can be read");
  }
  if (st.st_uid != uid) {
    close(fd);
    respond_error("FORBIDDEN", EACCES, "file owner UID does not match account UID");
  }
  if (st.st_nlink > 1) {
    close(fd);
    respond_error("FORBIDDEN", EMLINK, "hardlinked files are forbidden");
  }
  if ((int64_t)st.st_size > max_edit_bytes) {
    close(fd);
    respond_error("LIMIT_EXCEEDED", EFBIG, "file exceeds the 1 MiB editor limit");
  }

  size_t cap = (size_t)max_edit_bytes + 1;
  char *buf = calloc(1, cap + 1);
  if (!buf) _exit(12);
  size_t total = 0;
  while (total < cap) {
    ssize_t n = read(fd, buf + total, cap - total);
    if (n < 0) {
      if (errno == EINTR) continue;
      int err = errno;
      close(fd);
      free(buf);
      respond_errno(err, "read failed");
    }
    if (n == 0) break;
    total += (size_t)n;
  }
  close(fd);
  if ((int64_t)total > max_edit_bytes) {
    free(buf);
    respond_error("LIMIT_EXCEEDED", EFBIG, "file exceeds the 1 MiB editor limit");
  }
  if (!is_valid_utf8(buf, total)) {
    free(buf);
    respond_error("VALIDATION", EINVAL, "file content is not valid UTF-8 text");
  }

  char mtime[32];
  format_iso8601_utc(&st.st_mtim, mtime);
  StrBuf sb;
  sb_init(&sb, total + 256);
  sb_append_str(&sb, "{\"path\":");
  sb_append_json_str(&sb, path, path_len);
  sb_append_str(&sb, ",\"content\":");
  sb_append_json_str(&sb, buf, total);
  sb_append_fmt(&sb, ",\"sizeBytes\":%zu,\"mtime\":", total);
  sb_append_json_cstr(&sb, mtime);
  sb_append_char(&sb, '}');
  free(buf);
  respond_success_raw(sb.data);
}

static int b64_digit(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

static bool decode_base64(const char *in, size_t in_len, unsigned char **out, size_t *out_len) {
  if (in_len == 0) {
    unsigned char *empty = calloc(1, 1);
    if (!empty) _exit(12);
    *out = empty;
    *out_len = 0;
    return true;
  }
  if ((in_len % 4) != 0 || in_len > ((size_t)XP_MAX_BINARY_BYTES + 2) / 3 * 4) return false;
  size_t cap = in_len / 4 * 3;
  unsigned char *buf = malloc(cap ? cap : 1);
  if (!buf) _exit(12);
  size_t n = 0;
  for (size_t i = 0; i < in_len; i += 4) {
    int pad = 0;
    int v[4];
    for (int j = 0; j < 4; j++) {
      char c = in[i + (size_t)j];
      if (c == '=') {
        if (j < 2) {
          free(buf);
          return false;
        }
        v[j] = 0;
        pad++;
      } else if (pad != 0) {
        free(buf);
        return false;
      } else {
        int digit = b64_digit(c);
        if (digit < 0) {
          free(buf);
          return false;
        }
        v[j] = digit;
      }
    }
    if (pad > 2) {
      free(buf);
      return false;
    }
    buf[n++] = (unsigned char)((v[0] << 2) | (v[1] >> 4));
    if (pad < 2) buf[n++] = (unsigned char)(((v[1] & 15) << 4) | (v[2] >> 2));
    if (pad < 1) buf[n++] = (unsigned char)(((v[2] & 3) << 6) | v[3]);
  }
  if (n > (size_t)XP_MAX_BINARY_BYTES) {
    free(buf);
    return false;
  }
  *out = buf;
  *out_len = n;
  return true;
}

static const char B64_ALPHABET[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static void append_base64(StrBuf *sb, const unsigned char *data, size_t len) {
  for (size_t i = 0; i < len; i += 3) {
    unsigned int value = ((unsigned int)data[i]) << 16;
    if (i + 1 < len) value |= ((unsigned int)data[i + 1]) << 8;
    if (i + 2 < len) value |= (unsigned int)data[i + 2];
    sb_append_char(sb, B64_ALPHABET[(value >> 18) & 63]);
    sb_append_char(sb, B64_ALPHABET[(value >> 12) & 63]);
    sb_append_char(sb, i + 1 < len ? B64_ALPHABET[(value >> 6) & 63] : '=');
    sb_append_char(sb, i + 2 < len ? B64_ALPHABET[value & 63] : '=');
  }
}

typedef struct {
  bool exists;
  const char *content;
  size_t content_len;
  const char *mtime;
  bool remove;
} WriteCondition;

/* Directory flock serializes participating helper publishers. It is not a
 * claim of compare-and-swap against uncooperative external filesystem writers. */
static void check_write_preimage(int parent_fd, const char *base_name, uid_t uid,
                                 const WriteCondition *condition, bool exists, const struct stat *before) {
  if (!condition) return;
  if (exists != condition->exists) respond_error("CONFLICT", EAGAIN, "file preimage changed; reread before writing");
  if (!exists) return;
  int fd = xp_openat2(parent_fd, base_name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK, 0, XP_RESOLVE_CONFINED);
  if (fd < 0) respond_errno(errno, "openat2 checked preimage failed");
  struct stat opened, after, named;
  if (fstat(fd, &opened) != 0) { int err = errno; close(fd); respond_errno(err, "fstat checked preimage failed"); }
  char opened_mtime[32];
  format_iso8601_utc(&opened.st_mtim, opened_mtime);
  if (!S_ISREG(opened.st_mode) || opened.st_uid != uid || opened.st_nlink != 1 ||
      opened.st_dev != before->st_dev || opened.st_ino != before->st_ino ||
      opened.st_size < 0 || (uint64_t)opened.st_size != (uint64_t)condition->content_len || strcmp(opened_mtime, condition->mtime) != 0) {
    close(fd); respond_error("CONFLICT", EAGAIN, "file preimage identity changed");
  }
  char *bytes = calloc(1, condition->content_len + 1);
  if (!bytes) _exit(12);
  size_t count = 0;
  while (count <= condition->content_len) {
    ssize_t n = read(fd, bytes + count, condition->content_len + 1 - count);
    if (n < 0) { if (errno == EINTR) continue; int err = errno; close(fd); free(bytes); respond_errno(err, "read checked preimage failed"); }
    if (n == 0) break;
    count += (size_t)n;
  }
  bool stat_ok = fstat(fd, &after) == 0 && fstatat(parent_fd, base_name, &named, AT_SYMLINK_NOFOLLOW) == 0;
  close(fd);
  bool matches = count == condition->content_len && memcmp(bytes, condition->content, count) == 0;
  free(bytes);
  if (!stat_ok || !matches || after.st_dev != opened.st_dev || after.st_ino != opened.st_ino ||
      after.st_size != opened.st_size || after.st_mtim.tv_sec != opened.st_mtim.tv_sec || after.st_mtim.tv_nsec != opened.st_mtim.tv_nsec ||
      after.st_ctim.tv_sec != opened.st_ctim.tv_sec || after.st_ctim.tv_nsec != opened.st_ctim.tv_nsec ||
      named.st_dev != opened.st_dev || named.st_ino != opened.st_ino || named.st_size != opened.st_size ||
      named.st_mtim.tv_sec != opened.st_mtim.tv_sec || named.st_mtim.tv_nsec != opened.st_mtim.tv_nsec) {
    respond_error("CONFLICT", EAGAIN, "file preimage changed during comparison");
  }
}

static void publish_regular_bytes(int home_dirfd, uid_t uid, const char *path, size_t path_len,
                                  const unsigned char *bytes, size_t nbytes, bool overwrite, int64_t mode,
                                  int64_t max_file_mode, const WriteCondition *condition) {
  assert_safe_rel_path(path, path_len, false);
  if (mode <= 0 || mode > max_file_mode || (mode & ~max_file_mode) != 0) {
    respond_error("VALIDATION", EINVAL, "regular file mode must not exceed 0640");
  }
  char parent_rel[XP_MAX_PATH_BYTES + 1];
  char base_name[NAME_MAX + 1];
  split_rel_path(path, parent_rel, base_name);

  int parent_fd = open_confined_dir(home_dirfd, parent_rel, uid);
  if (flock(parent_fd, LOCK_EX | LOCK_NB) != 0) {
    int err = errno; close(parent_fd);
    if (err == EWOULDBLOCK || err == EAGAIN) respond_error("CONFLICT", err, "file publication directory is busy");
    respond_errno(err, "lock file publication directory failed");
  }

  struct stat existing_st;
  bool target_exists = false;
  if (fstatat(parent_fd, base_name, &existing_st, AT_SYMLINK_NOFOLLOW) == 0) {
    target_exists = true;
    if (S_ISLNK(existing_st.st_mode)) {
      close(parent_fd);
      respond_error("FORBIDDEN", ELOOP, "refusing to overwrite symbolic link");
    }
    if (S_ISDIR(existing_st.st_mode)) {
      close(parent_fd);
      respond_error("CONFLICT", EISDIR, "target path is a directory");
    }
    if (!S_ISREG(existing_st.st_mode)) {
      close(parent_fd);
      respond_error("FORBIDDEN", EACCES, "target path is a special file");
    }
    if (existing_st.st_uid != uid) {
      close(parent_fd);
      respond_error("FORBIDDEN", EACCES, "existing file owner UID mismatch");
    }
    if (existing_st.st_nlink > 1) {
      close(parent_fd);
      respond_error("FORBIDDEN", EMLINK, "refusing to overwrite hardlinked file");
    }
    if (!overwrite) {
      close(parent_fd);
      respond_error("CONFLICT", EEXIST, "target file already exists");
    }
  } else if (errno != ENOENT) {
    int err = errno;
    close(parent_fd);
    respond_errno(err, "fstatat target failed");
  }
  check_write_preimage(parent_fd, base_name, uid, condition, target_exists, &existing_st);
  if (condition && condition->remove) {
    if (target_exists && unlinkat(parent_fd, base_name, 0) != 0) { int err = errno; close(parent_fd); respond_errno(err, "checked unlink failed"); }
    if (fsync(parent_fd) != 0) { int err = errno; close(parent_fd); respond_error("SERVICE_UNAVAILABLE", err, "checked removal outcome requires inspection"); }
    close(parent_fd);
    respond_success_raw("null");
    return;
  }

  char rand_hex[17];
  generate_random_hex(rand_hex);
  char tmp_name[NAME_MAX + 1];
  snprintf(tmp_name, sizeof(tmp_name), ".xpanel-tmp-%d-%s", (int)getpid(), rand_hex);

  int tmp_fd = xp_openat2(parent_fd, tmp_name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, (uint64_t)mode, XP_RESOLVE_CONFINED);
  if (tmp_fd < 0) {
    int err = errno;
    close(parent_fd);
    respond_errno(err, "openat2 temporary file failed");
  }

  size_t off = 0;
  while (off < nbytes) {
    ssize_t n = write(tmp_fd, bytes + off, nbytes - off);
    if (n < 0) {
      if (errno == EINTR) continue;
      int err = errno;
      close(tmp_fd);
      (void)unlinkat(parent_fd, tmp_name, 0);
      close(parent_fd);
      respond_errno(err, "write temporary file failed");
    }
    off += (size_t)n;
  }

  if (fchmod(tmp_fd, (mode_t)mode) != 0) {
    int err = errno;
    close(tmp_fd);
    (void)unlinkat(parent_fd, tmp_name, 0);
    close(parent_fd);
    respond_errno(err, "fchmod temporary file failed");
  }

  if (fsync(tmp_fd) != 0) {
    int err = errno;
    close(tmp_fd);
    (void)unlinkat(parent_fd, tmp_name, 0);
    close(parent_fd);
    respond_errno(err, "fsync temporary file failed");
  }

  struct stat final_st;
  if (fstat(tmp_fd, &final_st) != 0) {
    int err = errno;
    close(tmp_fd);
    (void)unlinkat(parent_fd, tmp_name, 0);
    close(parent_fd);
    respond_errno(err, "fstat temporary file failed");
  }
  close(tmp_fd);

  if (condition) {
    struct stat guarded_st;
    int guarded_result = fstatat(parent_fd, base_name, &guarded_st, AT_SYMLINK_NOFOLLOW);
    bool changed = condition->exists
      ? guarded_result != 0 || guarded_st.st_dev != existing_st.st_dev || guarded_st.st_ino != existing_st.st_ino ||
        guarded_st.st_size != existing_st.st_size || guarded_st.st_mtim.tv_sec != existing_st.st_mtim.tv_sec ||
        guarded_st.st_mtim.tv_nsec != existing_st.st_mtim.tv_nsec || guarded_st.st_ctim.tv_sec != existing_st.st_ctim.tv_sec ||
        guarded_st.st_ctim.tv_nsec != existing_st.st_ctim.tv_nsec
      : guarded_result == 0 || errno != ENOENT;
    if (changed) {
      (void)unlinkat(parent_fd, tmp_name, 0); close(parent_fd);
      respond_error("CONFLICT", EAGAIN, "checked file changed before publication");
    }
  }
  unsigned int rename_flags = !overwrite || (condition && !condition->exists) ? RENAME_NOREPLACE : 0U;
  if (xp_renameat2(parent_fd, tmp_name, parent_fd, base_name, rename_flags) != 0) {
    int err = errno;
    (void)unlinkat(parent_fd, tmp_name, 0);
    close(parent_fd);
    respond_errno(err, "renameat2 publish failed");
  }

  if (fsync(parent_fd) != 0 && condition) { int err = errno; close(parent_fd); respond_error("SERVICE_UNAVAILABLE", err, "checked publication outcome requires inspection"); }
  close(parent_fd);

  StrBuf sb;
  sb_init(&sb, 256);
  append_file_entry_json(&sb, base_name, path, "file", (int64_t)nbytes, (mode_t)mode, &final_st.st_mtim);
  respond_success_raw(sb.data);
}

static void op_write(int home_dirfd, uid_t uid, const JsonVal *req, int64_t max_edit_bytes, int64_t max_file_mode) {
  const char *path = NULL;
  size_t path_len = 0;
  const char *content = NULL;
  size_t content_len = 0;
  bool overwrite = true;
  int64_t mode = 0;

  if (!jv_get_str(req, "path", &path, &path_len) ||
      !jv_get_str(req, "content", &content, &content_len) ||
      !jv_get_bool(req, "overwrite", &overwrite) ||
      !jv_get_int(req, "mode", &mode)) {
    respond_error("VALIDATION", EINVAL, "write requires path, content, overwrite, and mode");
  }
  if (!is_valid_utf8(content, content_len)) {
    respond_error("VALIDATION", EINVAL, "content must be valid UTF-8 text");
  }
  if ((int64_t)content_len > max_edit_bytes) {
    respond_error("LIMIT_EXCEEDED", EFBIG, "content exceeds the 1 MiB editor limit");
  }
  publish_regular_bytes(home_dirfd, uid, path, path_len, (const unsigned char *)content, content_len, overwrite, mode, max_file_mode, NULL);
}

static void op_write_checked(int home_dirfd, uid_t uid, const JsonVal *req, int64_t max_edit_bytes, int64_t max_file_mode) {
  const char *path = NULL, *content = NULL, *expected = NULL, *expected_mtime = NULL;
  size_t path_len = 0, content_len = 0, expected_len = 0, expected_mtime_len = 0;
  bool remove = false, expected_exists = false;
  int64_t mode = 0;
  if (!jv_get_str(req, "path", &path, &path_len) || !jv_get_str(req, "content", &content, &content_len) ||
      !jv_get_str(req, "expectedContent", &expected, &expected_len) || !jv_get_bool(req, "expectedExists", &expected_exists) ||
      !jv_get_str(req, "expectedMtime", &expected_mtime, &expected_mtime_len) ||
      !jv_get_bool(req, "remove", &remove) || !jv_get_int(req, "mode", &mode)) {
    respond_error("VALIDATION", EINVAL, "write-checked requires the exact preimage and replacement");
  }
  if ((!expected_exists && (expected_len != 0 || expected_mtime_len != 0)) || expected_mtime_len >= 32 || expected_mtime_len != strlen(expected_mtime) || (expected_exists && expected_mtime_len == 0) || (remove && content_len != 0) ||
      !is_valid_utf8(content, content_len) || !is_valid_utf8(expected, expected_len)) {
    respond_error("VALIDATION", EINVAL, "checked replacement and preimage must be valid UTF-8 text");
  }
  if ((int64_t)content_len > max_edit_bytes || (int64_t)expected_len > max_edit_bytes) respond_error("LIMIT_EXCEEDED", EFBIG, "checked text exceeds the editor limit");
  WriteCondition condition = { .exists = expected_exists, .content = expected, .content_len = expected_len, .mtime = expected_mtime, .remove = remove };
  publish_regular_bytes(home_dirfd, uid, path, path_len, (const unsigned char *)content, content_len, true, mode, max_file_mode, &condition);
}

static void op_put_bytes(int home_dirfd, uid_t uid, const JsonVal *req, int64_t max_file_mode) {
  const char *path = NULL;
  size_t path_len = 0;
  const char *encoded = NULL;
  size_t encoded_len = 0;
  bool overwrite = true;
  int64_t mode = 0;
  if (!jv_get_str(req, "path", &path, &path_len) ||
      !jv_get_str(req, "contentBase64", &encoded, &encoded_len) ||
      !jv_get_bool(req, "overwrite", &overwrite) ||
      !jv_get_int(req, "mode", &mode)) {
    respond_error("VALIDATION", EINVAL, "put-bytes requires path, contentBase64, overwrite, and mode");
  }
  unsigned char *bytes = NULL;
  size_t nbytes = 0;
  if (!decode_base64(encoded, encoded_len, &bytes, &nbytes) || nbytes > (size_t)XP_MAX_BINARY_BYTES) {
    free(bytes);
    respond_error("VALIDATION", EINVAL, "binary content must be canonical base64 within 2 MiB");
  }
  publish_regular_bytes(home_dirfd, uid, path, path_len, bytes, nbytes, overwrite, mode, max_file_mode, NULL);
}

static void op_get_bytes(int home_dirfd, uid_t uid, const JsonVal *req) {
  const char *path = NULL;
  size_t path_len = 0;
  if (!jv_get_str(req, "path", &path, &path_len)) {
    respond_error("VALIDATION", EINVAL, "get-bytes requires a string path");
  }
  assert_safe_rel_path(path, path_len, false);
  int fd = xp_openat2(home_dirfd, path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK, 0, XP_RESOLVE_CONFINED);
  if (fd < 0) respond_errno(errno, "openat2 read failed");
  struct stat st;
  if (fstat(fd, &st) != 0) {
    int err = errno;
    close(fd);
    respond_errno(err, "fstat read failed");
  }
  if (!S_ISREG(st.st_mode)) {
    close(fd);
    respond_error("FORBIDDEN", EACCES, "only regular files can be read");
  }
  if (st.st_uid != uid) {
    close(fd);
    respond_error("FORBIDDEN", EACCES, "file owner UID does not match account UID");
  }
  if (st.st_nlink > 1) {
    close(fd);
    respond_error("FORBIDDEN", EMLINK, "hardlinked files are forbidden");
  }
  if ((int64_t)st.st_size > XP_MAX_BINARY_BYTES) {
    close(fd);
    respond_error("LIMIT_EXCEEDED", EFBIG, "file exceeds the 2 MiB download limit");
  }
  size_t cap = (size_t)XP_MAX_BINARY_BYTES + 1;
  unsigned char *buf = calloc(1, cap);
  if (!buf) _exit(12);
  size_t total = 0;
  while (total < cap) {
    ssize_t n = read(fd, buf + total, cap - total);
    if (n < 0) {
      if (errno == EINTR) continue;
      int err = errno;
      close(fd);
      free(buf);
      respond_errno(err, "read failed");
    }
    if (n == 0) break;
    total += (size_t)n;
  }
  close(fd);
  if (total > (size_t)XP_MAX_BINARY_BYTES) {
    free(buf);
    respond_error("LIMIT_EXCEEDED", EFBIG, "file exceeds the 2 MiB download limit");
  }
  char mtime[32];
  format_iso8601_utc(&st.st_mtim, mtime);
  StrBuf sb;
  sb_init(&sb, total + 256);
  sb_append_str(&sb, "{\"path\":");
  sb_append_json_str(&sb, path, path_len);
  sb_append_str(&sb, ",\"contentBase64\":\"");
  append_base64(&sb, buf, total);
  sb_append_fmt(&sb, "\",\"sizeBytes\":%zu,\"mtime\":", total);
  sb_append_json_cstr(&sb, mtime);
  sb_append_char(&sb, '}');
  free(buf);
  respond_success_raw(sb.data);
}

static void op_mkdir(int home_dirfd, uid_t uid, const JsonVal *req, int64_t max_dir_mode) {
  const char *path = NULL;
  size_t path_len = 0;
  int64_t mode = 0;
  if (!jv_get_str(req, "path", &path, &path_len) || !jv_get_int(req, "mode", &mode)) {
    respond_error("VALIDATION", EINVAL, "mkdir requires path and mode");
  }
  assert_safe_rel_path(path, path_len, false);
  if (mode <= 0 || mode > max_dir_mode || (mode & ~max_dir_mode) != 0) {
    respond_error("VALIDATION", EINVAL, "directory mode must not exceed 0750");
  }

  char parent_rel[XP_MAX_PATH_BYTES + 1];
  char base_name[NAME_MAX + 1];
  split_rel_path(path, parent_rel, base_name);

  int parent_fd = open_confined_dir(home_dirfd, parent_rel, uid);
  if (mkdirat(parent_fd, base_name, (mode_t)mode) != 0) {
    int err = errno;
    close(parent_fd);
    respond_errno(err, "mkdirat failed");
  }

  int new_fd = xp_openat2(parent_fd, base_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0, XP_RESOLVE_CONFINED);
  if (new_fd < 0) {
    int err = errno;
    close(parent_fd);
    respond_errno(err, "openat2 created directory failed");
  }
  if (fchmod(new_fd, (mode_t)mode) != 0) {
    int err = errno;
    close(new_fd);
    close(parent_fd);
    respond_errno(err, "fchmod directory failed");
  }
  struct stat st;
  if (fstat(new_fd, &st) != 0) {
    int err = errno;
    close(new_fd);
    close(parent_fd);
    respond_errno(err, "fstat created directory failed");
  }
  close(new_fd);
  (void)fsync(parent_fd);
  close(parent_fd);

  StrBuf sb;
  sb_init(&sb, 256);
  append_file_entry_json(&sb, base_name, path, "directory", 0, (mode_t)mode, &st.st_mtim);
  respond_success_raw(sb.data);
}

static void op_chmod(int home_dirfd, uid_t uid, const JsonVal *req, int64_t max_file_mode, int64_t max_dir_mode) {
  const char *path = NULL;
  size_t path_len = 0;
  int64_t mode = 0;
  if (!jv_get_str(req, "path", &path, &path_len) || !jv_get_int(req, "mode", &mode)) {
    respond_error("VALIDATION", EINVAL, "chmod requires path and mode");
  }
  assert_safe_rel_path(path, path_len, false);

  char parent_rel[XP_MAX_PATH_BYTES + 1];
  char base_name[NAME_MAX + 1];
  split_rel_path(path, parent_rel, base_name);

  int fd = xp_openat2(home_dirfd, path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK, 0, XP_RESOLVE_CONFINED);
  if (fd < 0) {
    respond_errno(errno, "openat2 chmod target failed");
  }
  struct stat st;
  if (fstat(fd, &st) != 0) {
    int err = errno;
    close(fd);
    respond_errno(err, "fstat chmod target failed");
  }
  if (st.st_uid != uid) {
    close(fd);
    respond_error("FORBIDDEN", EACCES, "target owner UID mismatch");
  }
  const char *kind = NULL;
  if (S_ISREG(st.st_mode)) {
    if (st.st_nlink > 1) {
      close(fd);
      respond_error("FORBIDDEN", EMLINK, "hardlinked files are forbidden");
    }
    if (mode <= 0 || mode > max_file_mode || (mode & ~max_file_mode) != 0) {
      close(fd);
      respond_error("VALIDATION", EINVAL, "regular file mode must not exceed 0640");
    }
    kind = "file";
  } else if (S_ISDIR(st.st_mode)) {
    if (mode <= 0 || mode > max_dir_mode || (mode & ~max_dir_mode) != 0) {
      close(fd);
      respond_error("VALIDATION", EINVAL, "directory mode must not exceed 0750");
    }
    kind = "directory";
  } else {
    close(fd);
    respond_error("FORBIDDEN", EACCES, "cannot chmod special file or symlink");
  }

  if (fchmod(fd, (mode_t)mode) != 0) {
    int err = errno;
    close(fd);
    respond_errno(err, "fchmod failed");
  }
  if (fstat(fd, &st) != 0) {
    int err = errno;
    close(fd);
    respond_errno(err, "fstat after fchmod failed");
  }
  close(fd);

  StrBuf sb;
  sb_init(&sb, 256);
  append_file_entry_json(&sb, base_name, path, kind, S_ISDIR(st.st_mode) ? 0 : (int64_t)st.st_size,
                         (mode_t)mode, &st.st_mtim);
  respond_success_raw(sb.data);
}

/* --- Confined Trash Operations --- */

static int open_or_create_trash_dir(int home_dirfd, uid_t uid, bool create_if_missing) {
  if (create_if_missing) {
    if (mkdirat(home_dirfd, ".trash", 0700) != 0 && errno != EEXIST) {
      respond_errno(errno, "mkdirat .trash failed");
    }
  }
  int fd = xp_openat2(home_dirfd, ".trash", O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0, XP_RESOLVE_CONFINED);
  if (fd < 0) {
    if (!create_if_missing && errno == ENOENT) return -1;
    respond_errno(errno, "openat2 .trash failed");
  }
  struct stat st;
  if (fstat(fd, &st) != 0) {
    int err = errno;
    close(fd);
    respond_errno(err, "fstat .trash failed");
  }
  if (!S_ISDIR(st.st_mode) || st.st_uid != uid || (st.st_mode & 0027) != 0) {
    close(fd);
    respond_error("FORBIDDEN", EACCES, ".trash directory ownership or permissions are unsafe");
  }
  return fd;
}

typedef struct {
  char id[37];
  char original_path[XP_MAX_PATH_BYTES + 1];
  char name[NAME_MAX + 1];
  int64_t size_bytes;
  char deleted_at[32];
  int64_t deleted_epoch;
} TrashMeta;

static void read_and_validate_trash_meta(int trash_fd, uid_t uid, const char *id, TrashMeta *out) {
  if (!validate_uuid_v4(id)) {
    respond_error("CONFIG_TEST_FAILED", EINVAL, "corrupted trash identifier in .trash");
  }
  char meta_name[64];
  char item_name[64];
  snprintf(meta_name, sizeof(meta_name), "%s.meta", id);
  snprintf(item_name, sizeof(item_name), "%s.item", id);

  struct stat item_st;
  if (fstatat(trash_fd, item_name, &item_st, AT_SYMLINK_NOFOLLOW) != 0) {
    respond_errno(errno, "fstatat trash item failed");
  }
  if (item_st.st_uid != uid || (!S_ISREG(item_st.st_mode) && !S_ISDIR(item_st.st_mode)) ||
      (S_ISREG(item_st.st_mode) && item_st.st_nlink > 1)) {
    respond_error("FORBIDDEN", EACCES, "trashed item failed ownership or link-count invariant");
  }

  int mfd = xp_openat2(trash_fd, meta_name, O_RDONLY | O_NOFOLLOW, 0, XP_RESOLVE_CONFINED);
  if (mfd < 0) {
    respond_errno(errno, "openat2 trash metadata failed");
  }
  struct stat mst;
  if (fstat(mfd, &mst) != 0 || !S_ISREG(mst.st_mode) || mst.st_uid != uid || mst.st_nlink > 1 || mst.st_size <= 0 || mst.st_size > 4096) {
    close(mfd);
    respond_error("CONFIG_TEST_FAILED", EINVAL, "trash metadata file failed validation");
  }
  char buf[4097];
  ssize_t n = read(mfd, buf, 4096);
  close(mfd);
  if (n <= 0) {
    respond_error("CONFIG_TEST_FAILED", EIO, "reading trash metadata failed");
  }
  buf[n] = '\0';

  JsonParser p = {.src = buf, .len = (size_t)n, .pos = 0};
  JsonVal *root = jp_parse_value(&p, 0);
  jp_skip_ws(&p);
  if (!root || root->kind != JV_OBJECT || p.pos != p.len) {
    respond_error("CONFIG_TEST_FAILED", EINVAL, "corrupted trash metadata JSON");
  }
  const char *mid = NULL, *morig = NULL, *mname = NULL, *mdel = NULL;
  size_t morig_len = 0;
  int64_t msize = 0, mepoch = 0;
  if (!jv_get_str(root, "id", &mid, NULL) ||
      !jv_get_str(root, "originalPath", &morig, &morig_len) ||
      !jv_get_str(root, "name", &mname, NULL) ||
      !jv_get_int(root, "sizeBytes", &msize) ||
      !jv_get_str(root, "deletedAt", &mdel, NULL) ||
      !jv_get_int(root, "deletedEpoch", &mepoch)) {
    respond_error("CONFIG_TEST_FAILED", EINVAL, "missing fields in trash metadata");
  }
  if (strcmp(mid, id) != 0 || msize < 0) {
    respond_error("CONFIG_TEST_FAILED", EINVAL, "trash metadata ID mismatch");
  }
  assert_safe_rel_path(morig, morig_len, false);
  char parent_rel[XP_MAX_PATH_BYTES + 1];
  char expected_name[NAME_MAX + 1];
  split_rel_path(morig, parent_rel, expected_name);
  if (strcmp(expected_name, mname) != 0) {
    respond_error("CONFIG_TEST_FAILED", EINVAL, "trash metadata name mismatch");
  }

  snprintf(out->id, sizeof(out->id), "%s", id);
  snprintf(out->original_path, sizeof(out->original_path), "%s", morig);
  snprintf(out->name, sizeof(out->name), "%s", mname);
  out->size_bytes = msize;
  snprintf(out->deleted_at, sizeof(out->deleted_at), "%s", mdel);
  out->deleted_epoch = mepoch;
}

static void append_trash_item_json(StrBuf *sb, const TrashMeta *tm) {
  sb_append_str(sb, "{\"id\":");
  sb_append_json_cstr(sb, tm->id);
  sb_append_str(sb, ",\"originalPath\":");
  sb_append_json_cstr(sb, tm->original_path);
  sb_append_str(sb, ",\"name\":");
  sb_append_json_cstr(sb, tm->name);
  sb_append_fmt(sb, ",\"sizeBytes\":%" PRId64 ",\"deletedAt\":", tm->size_bytes);
  sb_append_json_cstr(sb, tm->deleted_at);
  sb_append_char(sb, '}');
}

static void op_trash(int home_dirfd, uid_t uid, const JsonVal *req) {
  const char *path = NULL;
  size_t path_len = 0;
  if (!jv_get_str(req, "path", &path, &path_len)) {
    respond_error("VALIDATION", EINVAL, "trash requires path");
  }
  assert_safe_rel_path(path, path_len, false);

  char parent_rel[XP_MAX_PATH_BYTES + 1];
  char base_name[NAME_MAX + 1];
  split_rel_path(path, parent_rel, base_name);

  int parent_fd = open_confined_dir(home_dirfd, parent_rel, uid);
  struct stat st;
  if (fstatat(parent_fd, base_name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
    int err = errno;
    close(parent_fd);
    respond_errno(err, "fstatat trash target failed");
  }
  if (st.st_uid != uid) {
    close(parent_fd);
    respond_error("FORBIDDEN", EACCES, "target owner UID mismatch");
  }
  if (!S_ISREG(st.st_mode) && !S_ISDIR(st.st_mode)) {
    close(parent_fd);
    respond_error("FORBIDDEN", EACCES, "only regular files and directories may be moved to trash");
  }
  if (S_ISREG(st.st_mode) && st.st_nlink > 1) {
    close(parent_fd);
    respond_error("FORBIDDEN", EMLINK, "hardlinked files cannot be moved to trash");
  }

  int trash_fd = open_or_create_trash_dir(home_dirfd, uid, true);
  TrashMeta tm;
  memset(&tm, 0, sizeof(tm));
  generate_uuid_v4(tm.id);
  snprintf(tm.original_path, sizeof(tm.original_path), "%s", path);
  snprintf(tm.name, sizeof(tm.name), "%s", base_name);
  tm.size_bytes = S_ISREG(st.st_mode) ? (int64_t)st.st_size : 0;

  struct timespec now_ts;
  clock_gettime(CLOCK_REALTIME, &now_ts);
  format_iso8601_utc(&now_ts, tm.deleted_at);
  tm.deleted_epoch = (int64_t)now_ts.tv_sec;

  StrBuf meta_sb;
  sb_init(&meta_sb, 256);
  sb_append_str(&meta_sb, "{\"id\":");
  sb_append_json_cstr(&meta_sb, tm.id);
  sb_append_str(&meta_sb, ",\"originalPath\":");
  sb_append_json_cstr(&meta_sb, tm.original_path);
  sb_append_str(&meta_sb, ",\"name\":");
  sb_append_json_cstr(&meta_sb, tm.name);
  sb_append_fmt(&meta_sb, ",\"sizeBytes\":%" PRId64 ",\"deletedAt\":", tm.size_bytes);
  sb_append_json_cstr(&meta_sb, tm.deleted_at);
  sb_append_fmt(&meta_sb, ",\"deletedEpoch\":%" PRId64 "}\n", tm.deleted_epoch);

  char meta_tmp[80];
  char meta_name[64];
  char item_name[64];
  snprintf(meta_tmp, sizeof(meta_tmp), ".xpanel-tmp-%s.meta", tm.id);
  snprintf(meta_name, sizeof(meta_name), "%s.meta", tm.id);
  snprintf(item_name, sizeof(item_name), "%s.item", tm.id);

  int mfd = xp_openat2(trash_fd, meta_tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600, XP_RESOLVE_CONFINED);
  if (mfd < 0) {
    int err = errno;
    close(trash_fd);
    close(parent_fd);
    respond_errno(err, "openat2 trash metadata temp failed");
  }
  ssize_t wn = write(mfd, meta_sb.data, meta_sb.len);
  int werr = errno;
  if (wn != (ssize_t)meta_sb.len || fsync(mfd) != 0) {
    if (wn == (ssize_t)meta_sb.len) werr = errno;
    close(mfd);
    (void)unlinkat(trash_fd, meta_tmp, 0);
    close(trash_fd);
    close(parent_fd);
    respond_errno(werr ? werr : EIO, "write trash metadata failed");
  }
  close(mfd);
  free(meta_sb.data);

  if (xp_renameat2(trash_fd, meta_tmp, trash_fd, meta_name, RENAME_NOREPLACE) != 0) {
    int err = errno;
    (void)unlinkat(trash_fd, meta_tmp, 0);
    close(trash_fd);
    close(parent_fd);
    respond_errno(err, "publish trash metadata failed");
  }

  if (xp_renameat2(parent_fd, base_name, trash_fd, item_name, RENAME_NOREPLACE) != 0) {
    int err = errno;
    (void)unlinkat(trash_fd, meta_name, 0);
    close(trash_fd);
    close(parent_fd);
    respond_errno(err, "move target to trash failed");
  }

  (void)fsync(parent_fd);
  (void)fsync(trash_fd);
  close(trash_fd);
  close(parent_fd);

  StrBuf out;
  sb_init(&out, 256);
  append_trash_item_json(&out, &tm);
  respond_success_raw(out.data);
}

static int cmp_trash_meta(const void *a, const void *b) {
  const TrashMeta *ta = (const TrashMeta *)a;
  const TrashMeta *tb = (const TrashMeta *)b;
  return strcmp(ta->id, tb->id);
}

static void op_list_trash(int home_dirfd, uid_t uid, int64_t max_list_entries) {
  int trash_fd = open_or_create_trash_dir(home_dirfd, uid, false);
  if (trash_fd < 0) {
    respond_success_raw("[]");
  }
  DIR *dirp = fdopendir(trash_fd);
  if (!dirp) {
    int err = errno;
    close(trash_fd);
    respond_errno(err, "fdopendir .trash failed");
  }
  rewinddir(dirp);

  size_t count = 0;
  size_t cap = 16;
  TrashMeta *items = calloc(cap, sizeof(TrashMeta));
  if (!items) _exit(12);

  while (true) {
    errno = 0;
    struct dirent *de = readdir(dirp);
    if (!de) {
      if (errno != 0) {
        int err = errno;
        closedir(dirp);
        respond_errno(err, "readdir .trash failed");
      }
      break;
    }
    const char *dname = de->d_name;
    if (strcmp(dname, ".") == 0 || strcmp(dname, "..") == 0) continue;
    size_t dlen = strlen(dname);
    if (dlen != 41 || strcmp(dname + 36, ".meta") != 0) continue;

    char id[37];
    memcpy(id, dname, 36);
    id[36] = '\0';

    if ((int64_t)(count + 1) > max_list_entries) {
      closedir(dirp);
      respond_error("LIMIT_EXCEEDED", E2BIG, "trash item count exceeds maxListEntries");
    }
    if (count == cap) {
      cap *= 2;
      TrashMeta *ni = realloc(items, cap * sizeof(TrashMeta));
      if (!ni) _exit(12);
      items = ni;
    }
    read_and_validate_trash_meta(dirfd(dirp), uid, id, &items[count]);
    count++;
  }
  closedir(dirp);

  if (count > 1) {
    qsort(items, count, sizeof(TrashMeta), cmp_trash_meta);
  }

  StrBuf sb;
  sb_init(&sb, 128 + count * 160);
  sb_append_char(&sb, '[');
  for (size_t i = 0; i < count; i++) {
    if (i > 0) sb_append_char(&sb, ',');
    append_trash_item_json(&sb, &items[i]);
  }
  sb_append_char(&sb, ']');
  respond_success_raw(sb.data);
}

static void op_restore(int home_dirfd, uid_t uid, const JsonVal *req, int64_t max_file_mode, int64_t max_dir_mode) {
  const char *trash_id = NULL;
  bool overwrite = false;
  if (!jv_get_str(req, "trashId", &trash_id, NULL) || !jv_get_bool(req, "overwrite", &overwrite)) {
    respond_error("VALIDATION", EINVAL, "restore requires trashId and overwrite");
  }
  if (!validate_uuid_v4(trash_id)) {
    respond_error("VALIDATION", EINVAL, "invalid trash item identifier");
  }

  int trash_fd = open_or_create_trash_dir(home_dirfd, uid, false);
  if (trash_fd < 0) {
    respond_error("NOT_FOUND", ENOENT, "trash item not found");
  }

  TrashMeta tm;
  read_and_validate_trash_meta(trash_fd, uid, trash_id, &tm);

  char item_name[64];
  char meta_name[64];
  snprintf(item_name, sizeof(item_name), "%s.item", trash_id);
  snprintf(meta_name, sizeof(meta_name), "%s.meta", trash_id);

  int item_fd = xp_openat2(trash_fd, item_name, O_RDONLY | O_NOFOLLOW, 0, XP_RESOLVE_CONFINED);
  if (item_fd < 0) {
    int err = errno;
    close(trash_fd);
    respond_errno(err, "openat2 trashed item failed");
  }
  struct stat item_st;
  if (fstat(item_fd, &item_st) != 0) {
    int err = errno;
    close(item_fd);
    close(trash_fd);
    respond_errno(err, "fstat trashed item failed");
  }
  mode_t ceiling = S_ISDIR(item_st.st_mode) ? (mode_t)max_dir_mode : (mode_t)max_file_mode;
  mode_t safe_mode = (item_st.st_mode & 07777) & ceiling;
  if (safe_mode == 0) safe_mode = S_ISDIR(item_st.st_mode) ? 0750 : 0640;
  if ((item_st.st_mode & 07777) != safe_mode) {
    if (fchmod(item_fd, safe_mode) != 0) {
      int err = errno;
      close(item_fd);
      close(trash_fd);
      respond_errno(err, "fchmod trashed item failed");
    }
    (void)fstat(item_fd, &item_st);
  }
  close(item_fd);

  char parent_rel[XP_MAX_PATH_BYTES + 1];
  char base_name[NAME_MAX + 1];
  split_rel_path(tm.original_path, parent_rel, base_name);

  int parent_fd = open_confined_dir(home_dirfd, parent_rel, uid);
  struct stat dest_st;
  if (fstatat(parent_fd, base_name, &dest_st, AT_SYMLINK_NOFOLLOW) == 0) {
    if (S_ISLNK(dest_st.st_mode) || dest_st.st_uid != uid || (S_ISREG(dest_st.st_mode) && dest_st.st_nlink > 1)) {
      close(parent_fd);
      close(trash_fd);
      respond_error("FORBIDDEN", EACCES, "restore destination failed safety check");
    }
    if (!overwrite) {
      close(parent_fd);
      close(trash_fd);
      respond_error("CONFLICT", EEXIST, "restore destination already exists");
    }
  } else if (errno != ENOENT) {
    int err = errno;
    close(parent_fd);
    close(trash_fd);
    respond_errno(err, "fstatat restore destination failed");
  }

  unsigned int rename_flags = overwrite ? 0U : RENAME_NOREPLACE;
  if (xp_renameat2(trash_fd, item_name, parent_fd, base_name, rename_flags) != 0) {
    int err = errno;
    close(parent_fd);
    close(trash_fd);
    respond_errno(err, "restore renameat2 failed");
  }
  (void)unlinkat(trash_fd, meta_name, 0);
  (void)fsync(parent_fd);
  (void)fsync(trash_fd);
  close(parent_fd);
  close(trash_fd);

  StrBuf sb;
  sb_init(&sb, 256);
  append_file_entry_json(&sb, base_name, tm.original_path,
                         S_ISDIR(item_st.st_mode) ? "directory" : "file",
                         S_ISDIR(item_st.st_mode) ? 0 : (int64_t)item_st.st_size,
                         safe_mode, &item_st.st_mtim);
  respond_success_raw(sb.data);
}

static void remove_tree_at(int parent_fd, const char *name, uid_t uid, int depth) {
  if (depth > 32) {
    respond_error("LIMIT_EXCEEDED", ELOOP, "directory nesting in trash exceeds limit");
  }
  struct stat st;
  if (fstatat(parent_fd, name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) return;
    respond_errno(errno, "fstatat during trash removal failed");
  }
  if (st.st_uid != uid) {
    respond_error("FORBIDDEN", EACCES, "refusing to delete entry owned by another UID");
  }
  if (!S_ISDIR(st.st_mode)) {
    if (unlinkat(parent_fd, name, 0) != 0 && errno != ENOENT) {
      respond_errno(errno, "unlinkat trash file failed");
    }
    return;
  }
  int sub_fd = xp_openat2(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0, XP_RESOLVE_CONFINED);
  if (sub_fd < 0) {
    respond_errno(errno, "openat2 trash subdirectory failed");
  }
  DIR *dirp = fdopendir(sub_fd);
  if (!dirp) {
    int err = errno;
    close(sub_fd);
    respond_errno(err, "fdopendir trash subdirectory failed");
  }
  while (true) {
    errno = 0;
    struct dirent *de = readdir(dirp);
    if (!de) {
      if (errno != 0) {
        int err = errno;
        closedir(dirp);
        respond_errno(err, "readdir trash subdirectory failed");
      }
      break;
    }
    if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0) continue;
    remove_tree_at(dirfd(dirp), de->d_name, uid, depth + 1);
  }
  closedir(dirp);
  if (unlinkat(parent_fd, name, AT_REMOVEDIR) != 0 && errno != ENOENT) {
    respond_errno(errno, "unlinkat trash directory failed");
  }
}

static void op_empty_trash(int home_dirfd, uid_t uid, const JsonVal *req) {
  bool has_retention = false;
  int64_t older_than_days = 0;
  if (jv_get(req, "olderThanDays") != NULL && jv_get(req, "olderThanDays")->kind != JV_NULL) {
    if (!jv_get_int(req, "olderThanDays", &older_than_days) || older_than_days < 0 || older_than_days > 36500) {
      respond_error("VALIDATION", EINVAL, "trash retention days must be in 0..36500");
    }
    has_retention = true;
  }

  int trash_fd = open_or_create_trash_dir(home_dirfd, uid, false);
  if (trash_fd < 0) {
    respond_success_raw("0");
  }
  DIR *dirp = fdopendir(trash_fd);
  if (!dirp) {
    int err = errno;
    close(trash_fd);
    respond_errno(err, "fdopendir .trash failed");
  }
  rewinddir(dirp);

  struct timespec now_ts;
  clock_gettime(CLOCK_REALTIME, &now_ts);
  int64_t cutoff_sec = (int64_t)now_ts.tv_sec - (older_than_days * 86400LL);

  int64_t removed = 0;
  while (true) {
    errno = 0;
    struct dirent *de = readdir(dirp);
    if (!de) {
      if (errno != 0) {
        int err = errno;
        closedir(dirp);
        respond_errno(err, "readdir .trash failed");
      }
      break;
    }
    const char *dname = de->d_name;
    size_t dlen = strlen(dname);
    if (dlen != 41 || strcmp(dname + 36, ".meta") != 0) continue;

    char id[37];
    memcpy(id, dname, 36);
    id[36] = '\0';

    TrashMeta tm;
    read_and_validate_trash_meta(dirfd(dirp), uid, id, &tm);
    if (has_retention && older_than_days > 0 && tm.deleted_epoch > cutoff_sec) {
      continue;
    }
    char item_name[64];
    char meta_name[64];
    snprintf(item_name, sizeof(item_name), "%s.item", id);
    snprintf(meta_name, sizeof(meta_name), "%s.meta", id);

    remove_tree_at(dirfd(dirp), item_name, uid, 0);
    if (unlinkat(dirfd(dirp), meta_name, 0) != 0 && errno != ENOENT) {
      int err = errno;
      closedir(dirp);
      respond_errno(err, "unlinkat trash metadata failed");
    }
    removed++;
  }
  (void)fsync(dirfd(dirp));
  closedir(dirp);

  char num_buf[32];
  snprintf(num_buf, sizeof(num_buf), "%" PRId64, removed);
  respond_success_raw(num_buf);
}

/* Permanently removes one trash item, only while its metadata still matches the revision the caller reviewed. */
static void op_purge_trash(int home_dirfd, uid_t uid, const JsonVal *req) {
  const char *trash_id = NULL, *expected_path = NULL, *expected_deleted_at = NULL;
  if (!jv_get_str(req, "trashId", &trash_id, NULL) || !jv_get_str(req, "originalPath", &expected_path, NULL) ||
      !jv_get_str(req, "deletedAt", &expected_deleted_at, NULL)) {
    respond_error("VALIDATION", EINVAL, "purge-trash requires trashId, originalPath and deletedAt");
  }
  if (!validate_uuid_v4(trash_id)) {
    respond_error("VALIDATION", EINVAL, "invalid trash item identifier");
  }

  int trash_fd = open_or_create_trash_dir(home_dirfd, uid, false);
  if (trash_fd < 0) {
    respond_error("NOT_FOUND", ENOENT, "trash item not found");
  }

  TrashMeta tm;
  read_and_validate_trash_meta(trash_fd, uid, trash_id, &tm);
  if (strcmp(tm.original_path, expected_path) != 0 || strcmp(tm.deleted_at, expected_deleted_at) != 0) {
    close(trash_fd);
    respond_error("CONFLICT", ESTALE, "trash item changed since it was read");
  }

  char item_name[64];
  char meta_name[64];
  snprintf(item_name, sizeof(item_name), "%s.item", trash_id);
  snprintf(meta_name, sizeof(meta_name), "%s.meta", trash_id);
  remove_tree_at(trash_fd, item_name, uid, 0);
  if (unlinkat(trash_fd, meta_name, 0) != 0 && errno != ENOENT) {
    int err = errno;
    close(trash_fd);
    respond_errno(err, "unlinkat trash metadata failed");
  }
  (void)fsync(trash_fd);
  close(trash_fd);

  StrBuf sb;
  sb_init(&sb, 256);
  append_trash_item_json(&sb, &tm);
  respond_success_raw(sb.data);
}

/* --- Confined move and copy --- */

static bool rel_path_within(const char *candidate, const char *base) {
  size_t n = strlen(base);
  return strncmp(candidate, base, n) == 0 && (candidate[n] == '\0' || candidate[n] == '/');
}

static bool skipped_tree_name(const char *name) {
  return strcmp(name, ".") == 0 || strcmp(name, "..") == 0 || strncmp(name, ".xpanel-tmp-", 12) == 0;
}

/* Moves and copies handle only account-owned directories and single-link regular files, never links or special files. */
static void require_managed_entry(const struct stat *st, uid_t uid) {
  if (st->st_uid != uid) respond_error("FORBIDDEN", EACCES, "entry owner UID does not match account UID");
  if (S_ISLNK(st->st_mode)) respond_error("FORBIDDEN", ELOOP, "symbolic links cannot be moved or copied");
  if (S_ISREG(st->st_mode) && st->st_nlink > 1) respond_error("FORBIDDEN", EMLINK, "hardlinked files cannot be moved or copied");
  if (!S_ISREG(st->st_mode) && !S_ISDIR(st->st_mode)) respond_error("FORBIDDEN", EACCES, "special files cannot be moved or copied");
}

static void read_source_and_destination(const JsonVal *req, const char *op, const char **path, const char **destination) {
  size_t path_len = 0, destination_len = 0;
  if (!jv_get_str(req, "path", path, &path_len) || !jv_get_str(req, "destination", destination, &destination_len)) {
    char msg[64];
    snprintf(msg, sizeof(msg), "%s requires path and destination", op);
    respond_error("VALIDATION", EINVAL, msg);
  }
  assert_safe_rel_path(*path, path_len, false);
  assert_safe_rel_path(*destination, destination_len, false);
  if (rel_path_within(*destination, *path)) {
    respond_error("VALIDATION", EINVAL, "destination must not be the source or inside it");
  }
}

/* Runs after the publishing rename, so a failure here reports an outcome that needs inspection, never a refusal. */
static void respond_entry_at(int dir_fd, const char *name, const char *rel_path) {
  struct stat st;
  if (fstatat(dir_fd, name, &st, AT_SYMLINK_NOFOLLOW) != 0) respond_error("SERVICE_UNAVAILABLE", errno, "result entry could not be read; outcome requires inspection");
  if (!S_ISREG(st.st_mode) && !S_ISDIR(st.st_mode)) respond_error("SERVICE_UNAVAILABLE", EAGAIN, "result entry changed during the operation; outcome requires inspection");
  StrBuf sb;
  sb_init(&sb, 256);
  append_file_entry_json(&sb, name, rel_path, S_ISDIR(st.st_mode) ? "directory" : "file",
                         S_ISDIR(st.st_mode) ? 0 : (int64_t)st.st_size, st.st_mode, &st.st_mtim);
  respond_success_raw(sb.data);
}

/* Renames one entry between two confined directories; an existing destination is never replaced. */
static void op_move(int home_dirfd, uid_t uid, const JsonVal *req) {
  const char *path = NULL, *destination = NULL;
  read_source_and_destination(req, "move", &path, &destination);
  char src_parent[XP_MAX_PATH_BYTES + 1], src_name[NAME_MAX + 1];
  char dst_parent[XP_MAX_PATH_BYTES + 1], dst_name[NAME_MAX + 1];
  split_rel_path(path, src_parent, src_name);
  split_rel_path(destination, dst_parent, dst_name);

  int src_fd = open_confined_dir(home_dirfd, src_parent, uid);
  int dst_fd = open_confined_dir(home_dirfd, dst_parent, uid);
  struct stat st;
  if (fstatat(src_fd, src_name, &st, AT_SYMLINK_NOFOLLOW) != 0) respond_errno(errno, "fstatat move source failed");
  require_managed_entry(&st, uid);
  if (xp_renameat2(src_fd, src_name, dst_fd, dst_name, RENAME_NOREPLACE) != 0) respond_errno(errno, "renameat2 move failed");
  (void)fsync(src_fd);
  (void)fsync(dst_fd);
  respond_entry_at(dst_fd, dst_name, destination);
}

typedef struct {
  int64_t entries;
  int64_t bytes;
  int64_t max_entries;
  int64_t max_bytes;
  const char *limit_message;
} CopyBudget;

typedef struct {
  const char *code;
  int err;
  const char *message;
} CopyFailure;

static CopyFailure g_copy_failure;
static char g_copy_buffer[65536];

static int copy_failed(const char *code, int err, const char *message) {
  g_copy_failure.code = code;
  g_copy_failure.err = err ? err : EIO;
  g_copy_failure.message = message;
  return -1;
}

static bool copy_budget_add(CopyBudget *budget, int64_t entries, int64_t bytes) {
  budget->entries += entries;
  budget->bytes += bytes;
  return budget->entries <= budget->max_entries && budget->bytes <= budget->max_bytes;
}

/* Bounds the whole source before anything is written, so a refused copy leaves no trace. */
static void scan_copy_source(int parent_fd, const char *name, uid_t uid, int depth, CopyBudget *budget) {
  if (depth > XP_MAX_TREE_DEPTH) respond_error("LIMIT_EXCEEDED", ELOOP, "directory nesting exceeds the copy limit");
  struct stat st;
  if (fstatat(parent_fd, name, &st, AT_SYMLINK_NOFOLLOW) != 0) respond_errno(errno, "fstatat copy source failed");
  require_managed_entry(&st, uid);
  if (!copy_budget_add(budget, 1, S_ISREG(st.st_mode) ? (int64_t)st.st_size : 0)) {
    respond_error("LIMIT_EXCEEDED", EFBIG, budget->limit_message);
  }
  if (S_ISREG(st.st_mode)) return;
  int fd = xp_openat2(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0, XP_RESOLVE_CONFINED);
  if (fd < 0) respond_errno(errno, "openat2 copy source directory failed");
  DIR *dirp = fdopendir(fd);
  if (!dirp) respond_errno(errno, "fdopendir copy source failed");
  for (;;) {
    errno = 0;
    struct dirent *de = readdir(dirp);
    if (!de) {
      if (errno != 0) respond_errno(errno, "readdir copy source failed");
      break;
    }
    if (!skipped_tree_name(de->d_name)) scan_copy_source(dirfd(dirp), de->d_name, uid, depth + 1, budget);
  }
  closedir(dirp);
}

static int copy_entry_at(int src_parent, const char *src_name, int dst_parent, const char *dst_name, uid_t uid, int depth,
                         int64_t max_file_mode, int64_t max_dir_mode, CopyBudget *budget);

static int copy_regular_fd(int src, const struct stat *st, int dst_parent, const char *dst_name, int64_t max_file_mode, CopyBudget *budget) {
  mode_t mode = (st->st_mode & 07777) & (mode_t)max_file_mode;
  if (mode == 0) mode = (mode_t)max_file_mode;
  int dst = xp_openat2(dst_parent, dst_name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600, XP_RESOLVE_CONFINED);
  if (dst < 0) return copy_failed(NULL, errno, "openat2 copy target failed");
  for (;;) {
    ssize_t n = read(src, g_copy_buffer, sizeof(g_copy_buffer));
    if (n < 0) {
      if (errno == EINTR) continue;
      int err = errno;
      close(dst);
      return copy_failed(NULL, err, "read copy source failed");
    }
    if (n == 0) break;
    if (!copy_budget_add(budget, 0, (int64_t)n)) {
      close(dst);
      return copy_failed("LIMIT_EXCEEDED", EFBIG, budget->limit_message);
    }
    for (ssize_t off = 0; off < n; ) {
      ssize_t w = write(dst, g_copy_buffer + off, (size_t)(n - off));
      if (w < 0) {
        if (errno == EINTR) continue;
        int err = errno;
        close(dst);
        return copy_failed(NULL, err, "write copy target failed");
      }
      off += w;
    }
  }
  if (fchmod(dst, mode) != 0) {
    int err = errno;
    close(dst);
    return copy_failed(NULL, err, "fchmod copy target failed");
  }
  close(dst);
  return 0;
}

static int copy_directory_fd(int src, const struct stat *st, int dst_parent, const char *dst_name, uid_t uid, int depth,
                             int64_t max_file_mode, int64_t max_dir_mode, CopyBudget *budget) {
  if (mkdirat(dst_parent, dst_name, 0700) != 0) return copy_failed(NULL, errno, "mkdirat copy target failed");
  int dst = xp_openat2(dst_parent, dst_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0, XP_RESOLVE_CONFINED);
  if (dst < 0) return copy_failed(NULL, errno, "openat2 copy target directory failed");
  int scan_fd = dup(src);
  DIR *dirp = scan_fd < 0 ? NULL : fdopendir(scan_fd);
  if (!dirp) {
    int err = errno;
    if (scan_fd >= 0) close(scan_fd);
    close(dst);
    return copy_failed(NULL, err, "fdopendir copy source failed");
  }
  int rc = 0;
  for (;;) {
    errno = 0;
    struct dirent *de = readdir(dirp);
    if (!de) {
      if (errno != 0) rc = copy_failed(NULL, errno, "readdir copy source failed");
      break;
    }
    if (skipped_tree_name(de->d_name)) continue;
    rc = copy_entry_at(dirfd(dirp), de->d_name, dst, de->d_name, uid, depth + 1, max_file_mode, max_dir_mode, budget);
    if (rc != 0) break;
  }
  closedir(dirp);
  mode_t mode = (st->st_mode & 07777) & (mode_t)max_dir_mode;
  if (mode == 0) mode = (mode_t)max_dir_mode;
  if (rc == 0 && fchmod(dst, mode) != 0) rc = copy_failed(NULL, errno, "fchmod copy target directory failed");
  close(dst);
  return rc;
}

static int copy_entry_at(int src_parent, const char *src_name, int dst_parent, const char *dst_name, uid_t uid, int depth,
                         int64_t max_file_mode, int64_t max_dir_mode, CopyBudget *budget) {
  if (depth > XP_MAX_TREE_DEPTH) return copy_failed("LIMIT_EXCEEDED", ELOOP, "directory nesting exceeds the copy limit");
  int src = xp_openat2(src_parent, src_name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK, 0, XP_RESOLVE_CONFINED);
  if (src < 0) return copy_failed(NULL, errno, "openat2 copy source failed");
  struct stat st;
  if (fstat(src, &st) != 0) {
    int err = errno;
    close(src);
    return copy_failed(NULL, err, "fstat copy source failed");
  }
  int rc;
  if (st.st_uid != uid || !(S_ISDIR(st.st_mode) || (S_ISREG(st.st_mode) && st.st_nlink == 1))) {
    rc = copy_failed("FORBIDDEN", EACCES, "copy source changed into an unsupported entry");
  } else if (!copy_budget_add(budget, 1, 0)) {
    rc = copy_failed("LIMIT_EXCEEDED", E2BIG, budget->limit_message);
  } else if (S_ISDIR(st.st_mode)) {
    rc = copy_directory_fd(src, &st, dst_parent, dst_name, uid, depth, max_file_mode, max_dir_mode, budget);
  } else {
    rc = copy_regular_fd(src, &st, dst_parent, dst_name, max_file_mode, budget);
  }
  close(src);
  return rc;
}

/* Best-effort removal of a staging tree this worker created; the original failure is what gets reported. */
static void discard_tree_at(int parent_fd, const char *name, int depth) {
  if (depth > XP_MAX_TREE_DEPTH + 1 || unlinkat(parent_fd, name, 0) == 0 || errno != EISDIR) return;
  int fd = xp_openat2(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0, XP_RESOLVE_CONFINED);
  if (fd < 0) return;
  (void)fchmod(fd, 0700);
  DIR *dirp = fdopendir(fd);
  if (!dirp) {
    close(fd);
    return;
  }
  struct dirent *de;
  while ((de = readdir(dirp)) != NULL) {
    if (strcmp(de->d_name, ".") != 0 && strcmp(de->d_name, "..") != 0) discard_tree_at(dirfd(dirp), de->d_name, depth + 1);
  }
  closedir(dirp);
  (void)unlinkat(parent_fd, name, AT_REMOVEDIR);
}

/* Copies a file or tree into a hidden staging name, then publishes it with one no-replace rename.
 * A worker killed at its timeout leaves the hidden staging tree behind until a listing sweeps it. */
static void op_copy(int home_dirfd, uid_t uid, const JsonVal *req, int64_t max_file_mode, int64_t max_dir_mode, int64_t max_list_entries) {
  const char *path = NULL, *destination = NULL;
  read_source_and_destination(req, "copy", &path, &destination);
  char src_parent[XP_MAX_PATH_BYTES + 1], src_name[NAME_MAX + 1];
  char dst_parent[XP_MAX_PATH_BYTES + 1], dst_name[NAME_MAX + 1];
  split_rel_path(path, src_parent, src_name);
  split_rel_path(destination, dst_parent, dst_name);

  int src_fd = open_confined_dir(home_dirfd, src_parent, uid);
  int dst_fd = open_confined_dir(home_dirfd, dst_parent, uid);
  struct stat existing;
  if (fstatat(dst_fd, dst_name, &existing, AT_SYMLINK_NOFOLLOW) == 0) respond_error("CONFLICT", EEXIST, "copy destination already exists");
  if (errno != ENOENT) respond_errno(errno, "fstatat copy destination failed");
  CopyBudget scanned = { .entries = 0, .bytes = 0, .max_entries = max_list_entries, .max_bytes = XP_MAX_COPY_BYTES, .limit_message = XP_COPY_LIMIT_MESSAGE };
  scan_copy_source(src_fd, src_name, uid, 0, &scanned);

  char rand_hex[17], staging[NAME_MAX + 1];
  generate_random_hex(rand_hex);
  snprintf(staging, sizeof(staging), ".xpanel-tmp-%d-%s", (int)getpid(), rand_hex);
  CopyBudget budget = { .entries = 0, .bytes = 0, .max_entries = max_list_entries, .max_bytes = XP_MAX_COPY_BYTES, .limit_message = XP_COPY_LIMIT_MESSAGE };
  if (copy_entry_at(src_fd, src_name, dst_fd, staging, uid, 0, max_file_mode, max_dir_mode, &budget) != 0) {
    discard_tree_at(dst_fd, staging, 0);
    if (g_copy_failure.code) respond_error(g_copy_failure.code, g_copy_failure.err, g_copy_failure.message);
    respond_errno(g_copy_failure.err, g_copy_failure.message);
  }
  if (syncfs(dst_fd) != 0) {
    int err = errno;
    discard_tree_at(dst_fd, staging, 0);
    respond_errno(err, "syncfs copy failed");
  }
  if (xp_renameat2(dst_fd, staging, dst_fd, dst_name, RENAME_NOREPLACE) != 0) {
    int err = errno;
    discard_tree_at(dst_fd, staging, 0);
    respond_errno(err, "publish copy failed");
  }
  (void)fsync(dst_fd);
  respond_entry_at(dst_fd, dst_name, destination);
}

/* --- Confined archives: compress and extract --- */

/* The codecs are the system zlib, libbz2 and libzstd, which the distribution package manager itself links.
 * They are loaded by soname inside the dropped-privilege worker, so the build needs no headers and a missing
 * library refuses only its own formats. */
#ifndef XP_ZLIB_SONAME
#define XP_ZLIB_SONAME "libz.so.1"
#endif
#ifndef XP_BZIP2_SONAME
#define XP_BZIP2_SONAME "libbz2.so.1"
#endif
#ifndef XP_ZSTD_SONAME
#define XP_ZSTD_SONAME "libzstd.so.1"
#endif

/* bzip2 -9 runs at about 11 MiB/s on one 3.6 GHz core; 512 MiB keeps the slowest codec inside the 120 s worker on a slower vCPU. */
#define XP_MAX_ARCHIVE_BYTES (512LL * 1024 * 1024)
#define XP_ARCHIVE_LIMIT_MESSAGE "archive exceeds the entry, 512 MiB size or disk quota limit"
#define XP_ARCHIVE_RATIO_FLOOR (16LL * 1024 * 1024)
#define XP_MAX_ARCHIVE_RATIO 250
#define XP_MAX_ZIP_DIRECTORY_BYTES (8 * 1024 * 1024)
#define XP_MAX_PAX_BYTES 65536
#define XP_IO_CHUNK 65536

static int64_t g_archive_quota_bytes;

typedef enum { XC_NONE, XC_GZIP, XC_DEFLATE, XC_BZIP2, XC_ZSTD } Codec;

/* Mirrors of the stable public stream structs (zlib 1.2+ and zlib-ng compat, bzip2 1.0, zstd 1.4+).
 * zlib's init functions also compare sizeof(z_stream) and refuse a mismatch. */
typedef struct {
  const unsigned char *next_in;
  unsigned int avail_in;
  unsigned long total_in;
  unsigned char *next_out;
  unsigned int avail_out;
  unsigned long total_out;
  const char *msg;
  void *state;
  void *zalloc;
  void *zfree;
  void *opaque;
  int data_type;
  unsigned long adler;
  unsigned long reserved;
} XpZStream;

typedef struct {
  char *next_in;
  unsigned int avail_in, total_in_lo32, total_in_hi32;
  char *next_out;
  unsigned int avail_out, total_out_lo32, total_out_hi32;
  void *state;
  void *bzalloc;
  void *bzfree;
  void *opaque;
} XpBzStream;

typedef struct { const void *src; size_t size, pos; } XpZstdIn;
typedef struct { void *dst; size_t size, pos; } XpZstdOut;

static struct {
  bool zlib, bzip2, zstd;
  const char *(*zlib_version)(void);
  int (*deflate_init2)(XpZStream *, int, int, int, int, int, const char *, int);
  int (*deflate)(XpZStream *, int);
  int (*deflate_end)(XpZStream *);
  int (*inflate_init2)(XpZStream *, int, const char *, int);
  int (*inflate)(XpZStream *, int);
  int (*inflate_reset)(XpZStream *);
  int (*inflate_end)(XpZStream *);
  unsigned long (*crc32)(unsigned long, const unsigned char *, unsigned int);
  int (*bz_compress_init)(XpBzStream *, int, int, int);
  int (*bz_compress)(XpBzStream *, int);
  int (*bz_compress_end)(XpBzStream *);
  int (*bz_decompress_init)(XpBzStream *, int, int);
  int (*bz_decompress)(XpBzStream *);
  int (*bz_decompress_end)(XpBzStream *);
  void *(*zstd_create_cctx)(void);
  size_t (*zstd_cctx_set)(void *, int, int);
  size_t (*zstd_compress2)(void *, XpZstdOut *, XpZstdIn *, int);
  size_t (*zstd_free_cctx)(void *);
  void *(*zstd_create_dctx)(void);
  size_t (*zstd_dctx_set)(void *, int, int);
  size_t (*zstd_decompress)(void *, XpZstdOut *, XpZstdIn *);
  size_t (*zstd_free_dctx)(void *);
  unsigned int (*zstd_is_error)(size_t);
} g_codec;

#define XP_BIND(handle, field, symbol) ((g_codec.field = (__typeof__(g_codec.field))dlsym(handle, symbol)) != NULL)

static void codec_unavailable(void) __attribute__((noreturn));
static void codec_unavailable(void) {
  respond_failure("PRECONDITION_FAILED", ENOSYS, "archive_format_unavailable", "the library for this archive format is not available on this server");
}

static void require_codec(Codec codec) {
  void *h;
  if ((codec == XC_GZIP || codec == XC_DEFLATE) && !g_codec.zlib) {
    h = dlopen(XP_ZLIB_SONAME, RTLD_NOW | RTLD_LOCAL);
    g_codec.zlib = h && XP_BIND(h, zlib_version, "zlibVersion") && XP_BIND(h, deflate_init2, "deflateInit2_") &&
      XP_BIND(h, deflate, "deflate") && XP_BIND(h, deflate_end, "deflateEnd") && XP_BIND(h, inflate_init2, "inflateInit2_") &&
      XP_BIND(h, inflate, "inflate") && XP_BIND(h, inflate_reset, "inflateReset") && XP_BIND(h, inflate_end, "inflateEnd") &&
      XP_BIND(h, crc32, "crc32");
    if (!g_codec.zlib) codec_unavailable();
  } else if (codec == XC_BZIP2 && !g_codec.bzip2) {
    h = dlopen(XP_BZIP2_SONAME, RTLD_NOW | RTLD_LOCAL);
    g_codec.bzip2 = h && XP_BIND(h, bz_compress_init, "BZ2_bzCompressInit") && XP_BIND(h, bz_compress, "BZ2_bzCompress") &&
      XP_BIND(h, bz_compress_end, "BZ2_bzCompressEnd") && XP_BIND(h, bz_decompress_init, "BZ2_bzDecompressInit") &&
      XP_BIND(h, bz_decompress, "BZ2_bzDecompress") && XP_BIND(h, bz_decompress_end, "BZ2_bzDecompressEnd");
    if (!g_codec.bzip2) codec_unavailable();
  } else if (codec == XC_ZSTD && !g_codec.zstd) {
    h = dlopen(XP_ZSTD_SONAME, RTLD_NOW | RTLD_LOCAL);
    g_codec.zstd = h && XP_BIND(h, zstd_create_cctx, "ZSTD_createCCtx") && XP_BIND(h, zstd_cctx_set, "ZSTD_CCtx_setParameter") &&
      XP_BIND(h, zstd_compress2, "ZSTD_compressStream2") && XP_BIND(h, zstd_free_cctx, "ZSTD_freeCCtx") &&
      XP_BIND(h, zstd_create_dctx, "ZSTD_createDCtx") && XP_BIND(h, zstd_dctx_set, "ZSTD_DCtx_setParameter") &&
      XP_BIND(h, zstd_decompress, "ZSTD_decompressStream") && XP_BIND(h, zstd_free_dctx, "ZSTD_freeDCtx") &&
      XP_BIND(h, zstd_is_error, "ZSTD_isError");
    if (!g_codec.zstd) codec_unavailable();
  }
}

static void archive_malformed(void) __attribute__((noreturn));
static void archive_malformed(void) {
  respond_error("VALIDATION", EINVAL, "archive is malformed, truncated or corrupt");
}

static void write_fd_all(int fd, const void *data, size_t n) {
  const unsigned char *p = data;
  while (n > 0) {
    ssize_t w = write(fd, p, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      respond_errno(errno, "write archive output failed");
    }
    p += w;
    n -= (size_t)w;
  }
}

static void pread_exact(int fd, void *buf, size_t n, int64_t offset) {
  size_t got = 0;
  while (got < n) {
    ssize_t r = pread(fd, (unsigned char *)buf + got, n - got, (off_t)offset + (off_t)got);
    if (r < 0) {
      if (errno == EINTR) continue;
      respond_errno(errno, "read archive failed");
    }
    if (r == 0) archive_malformed();
    got += (size_t)r;
  }
}

/* --- Streaming compressor --- */

typedef struct {
  Codec codec;
  int fd;
  int64_t written;
  XpZStream z;
  XpBzStream bz;
  void *zstd;
  unsigned char out[XP_IO_CHUNK];
} Writer;

static void writer_open(Writer *w, Codec codec, int fd) {
  memset(&w->z, 0, sizeof(w->z));
  memset(&w->bz, 0, sizeof(w->bz));
  w->codec = codec;
  w->fd = fd;
  w->written = 0;
  w->zstd = NULL;
  require_codec(codec);
  bool ok = true;
  if (codec == XC_GZIP || codec == XC_DEFLATE) {
    ok = g_codec.deflate_init2(&w->z, 6, 8, codec == XC_GZIP ? 31 : -15, 8, 0, g_codec.zlib_version(), (int)sizeof(XpZStream)) == 0;
  } else if (codec == XC_BZIP2) {
    ok = g_codec.bz_compress_init(&w->bz, 9, 0, 0) == 0;
  } else if (codec == XC_ZSTD) {
    w->zstd = g_codec.zstd_create_cctx();
    ok = w->zstd && !g_codec.zstd_is_error(g_codec.zstd_cctx_set(w->zstd, 100 /* ZSTD_c_compressionLevel */, 3));
  }
  if (!ok) codec_unavailable();
}

static void writer_emit(Writer *w, size_t have) {
  write_fd_all(w->fd, w->out, have);
  w->written += (int64_t)have;
}

static void writer_put(Writer *w, const void *data, size_t n, bool finish) {
  /* bzip2 reports an empty BZ_RUN step as a parameter error, and it moves nothing for any codec. */
  if (n == 0 && !finish) return;
  if (w->codec == XC_NONE) {
    if (n) write_fd_all(w->fd, data, n);
    w->written += (int64_t)n;
    return;
  }
  if (w->codec == XC_GZIP || w->codec == XC_DEFLATE) {
    w->z.next_in = data;
    w->z.avail_in = (unsigned int)n;
    for (;;) {
      w->z.next_out = w->out;
      w->z.avail_out = sizeof(w->out);
      int rc = g_codec.deflate(&w->z, finish ? 4 /* Z_FINISH */ : 0);
      if (rc != 0 && rc != 1 && rc != -5) respond_error("CONFIG_TEST_FAILED", EIO, "archive compression failed");
      writer_emit(w, sizeof(w->out) - w->z.avail_out);
      if (finish ? rc == 1 /* Z_STREAM_END */ : w->z.avail_out != 0) break;
    }
  } else if (w->codec == XC_BZIP2) {
    w->bz.next_in = (char *)(uintptr_t)data;
    w->bz.avail_in = (unsigned int)n;
    for (;;) {
      w->bz.next_out = (char *)w->out;
      w->bz.avail_out = sizeof(w->out);
      int rc = g_codec.bz_compress(&w->bz, finish ? 2 /* BZ_FINISH */ : 0);
      if (rc < 0) respond_error("CONFIG_TEST_FAILED", EIO, "archive compression failed");
      writer_emit(w, sizeof(w->out) - w->bz.avail_out);
      if (finish ? rc == 4 /* BZ_STREAM_END */ : w->bz.avail_in == 0) break;
    }
  } else {
    XpZstdIn in = { data, n, 0 };
    for (;;) {
      XpZstdOut out = { w->out, sizeof(w->out), 0 };
      size_t left = g_codec.zstd_compress2(w->zstd, &out, &in, finish ? 2 /* ZSTD_e_end */ : 0);
      if (g_codec.zstd_is_error(left)) respond_error("CONFIG_TEST_FAILED", EIO, "archive compression failed");
      writer_emit(w, out.pos);
      if (finish ? left == 0 : in.pos == in.size) break;
    }
  }
}

static void writer_close(Writer *w) {
  if (w->codec == XC_NONE) return;
  writer_put(w, NULL, 0, true);
  if (w->codec == XC_GZIP || w->codec == XC_DEFLATE) g_codec.deflate_end(&w->z);
  else if (w->codec == XC_BZIP2) g_codec.bz_compress_end(&w->bz);
  else g_codec.zstd_free_cctx(w->zstd);
}

/* --- Streaming decompressor over a byte range of the archive file --- */

typedef struct {
  Codec codec;
  int fd;
  int64_t offset, remaining, produced, ratio_base;
  bool in_eof, ended;
  size_t in_len, in_pos;
  XpZStream z;
  XpBzStream bz;
  void *zstd;
  size_t zstd_hint;
  unsigned char in[XP_IO_CHUNK];
} Reader;

/* ratio_base is the compressed size that the output may outgrow only within the bomb ratio; 0 checks nothing. */
static void reader_open(Reader *r, Codec codec, int fd, int64_t offset, int64_t length, int64_t ratio_base) {
  memset(&r->z, 0, sizeof(r->z));
  memset(&r->bz, 0, sizeof(r->bz));
  r->codec = codec;
  r->fd = fd;
  r->offset = offset;
  r->remaining = length;
  r->produced = 0;
  r->ratio_base = ratio_base;
  r->in_eof = r->ended = false;
  r->in_len = r->in_pos = 0;
  r->zstd = NULL;
  r->zstd_hint = 0;
  require_codec(codec);
  bool ok = true;
  if (codec == XC_GZIP || codec == XC_DEFLATE) {
    ok = g_codec.inflate_init2(&r->z, codec == XC_GZIP ? 31 : -15, g_codec.zlib_version(), (int)sizeof(XpZStream)) == 0;
  } else if (codec == XC_BZIP2) {
    ok = g_codec.bz_decompress_init(&r->bz, 0, 0) == 0;
  } else if (codec == XC_ZSTD) {
    r->zstd = g_codec.zstd_create_dctx();
    /* A frame may declare a window up to 2 GiB; refuse more than 16 MiB inside the 64 MiB worker. */
    ok = r->zstd && !g_codec.zstd_is_error(g_codec.zstd_dctx_set(r->zstd, 100 /* ZSTD_d_windowLogMax */, 24));
  }
  if (!ok) codec_unavailable();
}

static bool reader_fill(Reader *r) {
  if (r->in_pos < r->in_len) return true;
  if (r->in_eof) return false;
  size_t want = r->remaining < (int64_t)sizeof(r->in) ? (size_t)r->remaining : sizeof(r->in);
  ssize_t n = 0;
  if (want > 0) {
    do { n = pread(r->fd, r->in, want, (off_t)r->offset); } while (n < 0 && errno == EINTR);
    if (n < 0) respond_errno(errno, "read archive failed");
  }
  if (n == 0) {
    r->in_eof = true;
    return false;
  }
  r->offset += n;
  r->remaining -= n;
  r->in_pos = 0;
  r->in_len = (size_t)n;
  return true;
}

/* Returns 0 only at the end of the stream; malformed input never returns. */
static size_t reader_read(Reader *r, unsigned char *out, size_t cap) {
  size_t got = 0;
  while (got == 0 && !r->ended && cap > 0) {
    bool more = reader_fill(r);
    if (r->codec == XC_NONE) {
      if (!more) { r->ended = true; break; }
      got = r->in_len - r->in_pos < cap ? r->in_len - r->in_pos : cap;
      memcpy(out, r->in + r->in_pos, got);
      r->in_pos += got;
    } else if (r->codec == XC_GZIP || r->codec == XC_DEFLATE) {
      r->z.next_in = r->in + r->in_pos;
      r->z.avail_in = (unsigned int)(r->in_len - r->in_pos);
      r->z.next_out = out;
      r->z.avail_out = (unsigned int)cap;
      int rc = g_codec.inflate(&r->z, 0);
      r->in_pos = r->in_len - r->z.avail_in;
      got = cap - r->z.avail_out;
      if (rc == 1 /* Z_STREAM_END */) {
        /* A following gzip member continues the stream; other trailing bytes are padding. */
        if (r->codec == XC_GZIP && reader_fill(r) && r->in[r->in_pos] == 0x1f) {
          if (g_codec.inflate_reset(&r->z) != 0) archive_malformed();
        } else {
          r->ended = true;
        }
      } else if (rc == -5 /* Z_BUF_ERROR */) {
        if (!more) archive_malformed();
      } else if (rc != 0) {
        archive_malformed();
      }
    } else if (r->codec == XC_BZIP2) {
      r->bz.next_in = (char *)(r->in + r->in_pos);
      r->bz.avail_in = (unsigned int)(r->in_len - r->in_pos);
      r->bz.next_out = (char *)out;
      r->bz.avail_out = (unsigned int)cap;
      int rc = g_codec.bz_decompress(&r->bz);
      r->in_pos = r->in_len - r->bz.avail_in;
      got = cap - r->bz.avail_out;
      if (rc == 4 /* BZ_STREAM_END */) {
        g_codec.bz_decompress_end(&r->bz);
        memset(&r->bz, 0, sizeof(r->bz));
        if (reader_fill(r) && r->in[r->in_pos] == 'B') {
          if (g_codec.bz_decompress_init(&r->bz, 0, 0) != 0) archive_malformed();
        } else {
          r->ended = true;
        }
      } else if (rc != 0 || (got == 0 && !more)) {
        archive_malformed();
      }
    } else {
      XpZstdIn in = { r->in + r->in_pos, r->in_len - r->in_pos, 0 };
      XpZstdOut o = { out, cap, 0 };
      size_t rc = g_codec.zstd_decompress(r->zstd, &o, &in);
      if (g_codec.zstd_is_error(rc)) archive_malformed();
      r->in_pos += in.pos;
      got = o.pos;
      /* Only a call that moved data tells whether the last frame is complete (0) or still open. */
      if (in.size > 0 || got > 0) r->zstd_hint = rc;
      if (got == 0 && !more) {
        rc = r->zstd_hint;
        if (rc != 0) archive_malformed();
        r->ended = true;
      }
    }
  }
  r->produced += (int64_t)got;
  if (r->ratio_base > 0 && r->produced > XP_ARCHIVE_RATIO_FLOOR && r->produced / XP_MAX_ARCHIVE_RATIO > r->ratio_base) {
    respond_error("LIMIT_EXCEEDED", EFBIG, "archive expands beyond the decompression ratio limit");
  }
  return got;
}

static size_t reader_full(Reader *r, unsigned char *out, size_t n) {
  size_t got = 0;
  while (got < n) {
    size_t step = reader_read(r, out + got, n - got);
    if (step == 0) break;
    got += step;
  }
  return got;
}

static void reader_skip(Reader *r, int64_t n) {
  while (n > 0) {
    size_t step = n < (int64_t)sizeof(g_copy_buffer) ? (size_t)n : sizeof(g_copy_buffer);
    if (reader_full(r, (unsigned char *)g_copy_buffer, step) != step) archive_malformed();
    n -= (int64_t)step;
  }
}

static void reader_close(Reader *r) {
  if (r->codec == XC_GZIP || r->codec == XC_DEFLATE) g_codec.inflate_end(&r->z);
  else if (r->codec == XC_BZIP2 && !r->ended) g_codec.bz_decompress_end(&r->bz);
  else if (r->codec == XC_ZSTD) g_codec.zstd_free_dctx(r->zstd);
}

/* --- Extraction into a hidden staging folder --- */

typedef struct {
  int root_fd;
  int parent_fd;
  int64_t entries, bytes, max_entries, max_bytes;
  char parent[XP_MAX_PATH_BYTES + 1];
} Extract;

/* Normalizes and validates one entry name. Returns false for the archive's own root entry ("./"). */
static bool archive_entry_name(const char *raw, size_t len, char out[XP_MAX_PATH_BYTES + 1], bool *directory) {
  while (len >= 2 && raw[0] == '.' && raw[1] == '/') { raw += 2; len -= 2; }
  *directory = false;
  while (len > 0 && raw[len - 1] == '/') { len--; *directory = true; }
  if (len == 0 || (len == 1 && raw[0] == '.')) return false;
  if (len > XP_MAX_PATH_BYTES) respond_error("LIMIT_EXCEEDED", ENAMETOOLONG, "archive entry path is too long");
  if (memchr(raw, '\0', len)) respond_error("FORBIDDEN", EACCES, "archive entry name contains a NUL byte");
  memcpy(out, raw, len);
  out[len] = '\0';
  /* Refuses absolute names, drive letters, "..", empty segments, backslashes, control bytes and the trash. */
  assert_safe_rel_path(out, len, false);
  int depth = 0;
  for (const char *segment = out; segment; ) {
    const char *slash = strchr(segment, '/');
    size_t seg_len = slash ? (size_t)(slash - segment) : strlen(segment);
    if (seg_len > NAME_MAX) respond_error("VALIDATION", ENAMETOOLONG, "archive entry name segment exceeds NAME_MAX");
    if (strncmp(segment, ".xpanel-tmp-", 12) == 0) respond_error("FORBIDDEN", EACCES, "archive entry uses a reserved staging name");
    if (++depth > XP_MAX_TREE_DEPTH) respond_error("LIMIT_EXCEEDED", ELOOP, "archive entry nesting exceeds the depth limit");
    segment = slash ? slash + 1 : NULL;
  }
  return true;
}

static void extract_count(Extract *x, int64_t declared_bytes) {
  if (++x->entries > x->max_entries || declared_bytes < 0 || declared_bytes > x->max_bytes - x->bytes) {
    respond_error("LIMIT_EXCEEDED", EFBIG, XP_ARCHIVE_LIMIT_MESSAGE);
  }
}

/* Opens (creating as needed) the folder holding path, beneath the staging root and without following links. */
static int extract_parent(Extract *x, const char *path, char leaf[NAME_MAX + 1]) {
  const char *slash = strrchr(path, '/');
  size_t plen = slash ? (size_t)(slash - path) : 0;
  snprintf(leaf, NAME_MAX + 1, "%s", slash ? slash + 1 : path);
  if (x->parent_fd >= 0 && strlen(x->parent) == plen && memcmp(x->parent, path, plen) == 0) return x->parent_fd;
  if (x->parent_fd >= 0 && x->parent_fd != x->root_fd) close(x->parent_fd);
  x->parent_fd = -1;
  int fd = x->root_fd;
  for (size_t start = 0; start < plen; ) {
    const char *end = memchr(path + start, '/', plen - start);
    size_t seg_len = end ? (size_t)(end - (path + start)) : plen - start;
    char segment[NAME_MAX + 1];
    memcpy(segment, path + start, seg_len);
    segment[seg_len] = '\0';
    if (mkdirat(fd, segment, 0750) != 0 && errno != EEXIST) respond_errno(errno, "create archive folder failed");
    int next = xp_openat2(fd, segment, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0, XP_RESOLVE_CONFINED);
    if (next < 0) {
      if (errno == ENOTDIR) respond_error("CONFLICT", ENOTDIR, "archive uses one name for both a file and a folder");
      respond_errno(errno, "open archive folder failed");
    }
    if (fd != x->root_fd) close(fd);
    fd = next;
    start += seg_len + 1;
  }
  memcpy(x->parent, path, plen);
  x->parent[plen] = '\0';
  x->parent_fd = fd;
  return fd;
}

static void extract_dir(Extract *x, const char *path, mode_t mode) {
  extract_count(x, 0);
  char leaf[NAME_MAX + 1];
  int parent = extract_parent(x, path, leaf);
  if (mkdirat(parent, leaf, (mode & 0750) | 0700) == 0) return;
  struct stat st;
  if (errno != EEXIST) respond_errno(errno, "create archive folder failed");
  if (fstatat(parent, leaf, &st, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISDIR(st.st_mode)) {
    respond_error("CONFLICT", EEXIST, "archive uses one name for both a file and a folder");
  }
}

static int extract_file_open(Extract *x, const char *path, int64_t declared_bytes) {
  extract_count(x, declared_bytes);
  char leaf[NAME_MAX + 1];
  int parent = extract_parent(x, path, leaf);
  int fd = xp_openat2(parent, leaf, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600, XP_RESOLVE_CONFINED);
  if (fd < 0) {
    if (errno == EEXIST) respond_error("CONFLICT", EEXIST, "archive contains the same entry twice");
    respond_errno(errno, "create archive file failed");
  }
  return fd;
}

static void extract_write(Extract *x, int fd, const unsigned char *data, size_t n) {
  if ((int64_t)n > x->max_bytes - x->bytes) respond_error("LIMIT_EXCEEDED", EFBIG, XP_ARCHIVE_LIMIT_MESSAGE);
  x->bytes += (int64_t)n;
  write_fd_all(fd, data, n);
}

/* Setuid, setgid, sticky and execute bits never survive: modes are clamped to the 0640 file ceiling. */
static void extract_file_close(int fd, mode_t mode, time_t mtime) {
  if (fchmod(fd, (mode & 0640) | 0600) != 0) respond_errno(errno, "set archive file mode failed");
  struct timespec times[2] = { { mtime, 0 }, { mtime, 0 } };
  (void)futimens(fd, times);
  close(fd);
}

/* --- tar (ustar, pax and GNU long names) --- */

static int64_t tar_number(const unsigned char *field, size_t len, bool *ok) {
  if (field[0] & 0x80) { *ok = false; return 0; }
  size_t i = 0;
  while (i < len && field[i] == ' ') i++;
  int64_t value = 0;
  for (; i < len && field[i] >= '0' && field[i] <= '7'; i++) {
    if (value > (INT64_MAX >> 3)) { *ok = false; return 0; }
    value = value * 8 + (field[i] - '0');
  }
  for (; i < len; i++) if (field[i] != ' ' && field[i] != '\0') *ok = false;
  return value;
}

static bool tar_checksum_ok(const unsigned char h[512]) {
  bool ok = true;
  int64_t stored = tar_number(h + 148, 8, &ok);
  int64_t unsigned_sum = 0, signed_sum = 0;
  for (int i = 0; i < 512; i++) {
    unsigned char c = (i >= 148 && i < 156) ? ' ' : h[i];
    unsigned_sum += c;
    signed_sum += (signed char)c;
  }
  return ok && (stored == unsigned_sum || stored == signed_sum);
}

static bool all_zero(const unsigned char *p, size_t n) {
  for (size_t i = 0; i < n; i++) if (p[i]) return false;
  return true;
}

static void tar_parse_pax(const char *data, size_t len, char path[XP_MAX_PATH_BYTES + 2], bool *have_path, int64_t *size) {
  size_t pos = 0;
  while (pos < len) {
    size_t record = 0, i = pos;
    while (i < len && data[i] >= '0' && data[i] <= '9') {
      record = record * 10 + (size_t)(data[i] - '0');
      if (record > len) archive_malformed();
      i++;
    }
    if (i >= len || data[i] != ' ' || record == 0 || record > len - pos || data[pos + record - 1] != '\n') archive_malformed();
    const char *key = data + i + 1;
    size_t kv_len = pos + record - 1 - (i + 1);
    const char *eq = memchr(key, '=', kv_len);
    if (!eq) archive_malformed();
    size_t key_len = (size_t)(eq - key), value_len = kv_len - key_len - 1;
    const char *value = eq + 1;
    if (key_len == 4 && memcmp(key, "path", 4) == 0) {
      if (value_len > XP_MAX_PATH_BYTES) respond_error("LIMIT_EXCEEDED", ENAMETOOLONG, "archive entry path is too long");
      if (memchr(value, '\0', value_len)) respond_error("FORBIDDEN", EACCES, "archive entry name contains a NUL byte");
      memcpy(path, value, value_len);
      path[value_len] = '\0';
      *have_path = true;
    } else if (key_len == 4 && memcmp(key, "size", 4) == 0) {
      int64_t parsed = 0;
      if (value_len == 0 || value_len > 18) archive_malformed();
      for (size_t k = 0; k < value_len; k++) {
        if (value[k] < '0' || value[k] > '9') archive_malformed();
        parsed = parsed * 10 + (value[k] - '0');
      }
      *size = parsed;
    } else if (key_len > 11 && memcmp(key, "GNU.sparse.", 11) == 0) {
      respond_error("VALIDATION", EINVAL, "archive contains a sparse file, which is not supported");
    }
    pos += record;
  }
}

static void extract_tar(Extract *x, Reader *r, const unsigned char first[512]) {
  unsigned char h[512];
  char override[XP_MAX_PATH_BYTES + 2];
  bool have_override = false, use_first = true;
  int64_t override_size = -1;
  for (;;) {
    if (use_first) {
      memcpy(h, first, 512);
      use_first = false;
    } else {
      size_t n = reader_full(r, h, 512);
      if (n == 0) return;
      if (n != 512) archive_malformed();
    }
    if (all_zero(h, 512)) {
      size_t n = reader_full(r, h, 512);
      if (n == 0 || (n == 512 && all_zero(h, 512))) return;
      archive_malformed();
    }
    if (!tar_checksum_ok(h)) archive_malformed();
    bool ok = true, mtime_ok = true;
    int64_t size = tar_number(h + 124, 12, &ok);
    mode_t mode = (mode_t)tar_number(h + 100, 8, &ok);
    time_t mtime = (time_t)tar_number(h + 136, 12, &mtime_ok);
    if (!ok) archive_malformed();
    if (!mtime_ok) mtime = 0;
    if (override_size >= 0) size = override_size;
    int64_t padded = size + ((512 - size % 512) % 512);
    char type = (char)h[156];
    if (type == 'x' || type == 'L') {
      if (size > (type == 'x' ? XP_MAX_PAX_BYTES : XP_MAX_PATH_BYTES + 1)) respond_error("LIMIT_EXCEEDED", E2BIG, "archive entry header is too large");
      char *data = calloc(1, (size_t)size + 1);
      if (!data) _exit(12);
      if (reader_full(r, (unsigned char *)data, (size_t)size) != (size_t)size) archive_malformed();
      reader_skip(r, padded - size);
      if (type == 'x') {
        tar_parse_pax(data, (size_t)size, override, &have_override, &override_size);
      } else {
        snprintf(override, sizeof(override), "%s", data);
        have_override = true;
      }
      free(data);
      continue;
    }
    if (type == 'g' || type == 'K') {
      reader_skip(r, padded);
      continue;
    }
    if (type == '1' || type == '2') respond_error("FORBIDDEN", ELOOP, "archive contains a link; links are not extracted");
    if (type == '3' || type == '4' || type == '6') respond_error("FORBIDDEN", EACCES, "archive contains a device or FIFO entry");
    if (type != '0' && type != '\0' && type != '7' && type != '5') respond_error("VALIDATION", EINVAL, "archive contains an unsupported entry type");

    char name[XP_MAX_PATH_BYTES + 2];
    if (have_override) {
      snprintf(name, sizeof(name), "%s", override);
    } else {
      char base[101], prefix[156];
      memcpy(base, h, 100);
      base[100] = '\0';
      memcpy(prefix, h + 345, 155);
      prefix[155] = '\0';
      if (memcmp(h + 257, "ustar", 6) == 0 && prefix[0]) snprintf(name, sizeof(name), "%s/%s", prefix, base);
      else snprintf(name, sizeof(name), "%s", base);
    }
    have_override = false;
    override_size = -1;
    char path[XP_MAX_PATH_BYTES + 1];
    bool directory = false;
    if (!archive_entry_name(name, strlen(name), path, &directory)) {
      reader_skip(r, padded);
      continue;
    }
    if (type == '5' || directory) {
      extract_dir(x, path, mode);
      reader_skip(r, padded);
      continue;
    }
    int fd = extract_file_open(x, path, size);
    for (int64_t left = size; left > 0; ) {
      size_t step = left < (int64_t)sizeof(g_copy_buffer) ? (size_t)left : sizeof(g_copy_buffer);
      size_t n = reader_read(r, (unsigned char *)g_copy_buffer, step);
      if (n == 0) archive_malformed();
      extract_write(x, fd, (const unsigned char *)g_copy_buffer, n);
      left -= (int64_t)n;
    }
    reader_skip(r, padded - size);
    extract_file_close(fd, mode, mtime);
  }
}

/* --- zip (stored and deflate, zip64 sizes) --- */

static uint16_t le16(const unsigned char *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static uint32_t le32(const unsigned char *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
static uint64_t le64(const unsigned char *p) { return (uint64_t)le32(p) | ((uint64_t)le32(p + 4) << 32); }
static void put16(unsigned char *p, uint32_t v) { p[0] = (unsigned char)v; p[1] = (unsigned char)(v >> 8); }
static void put32(unsigned char *p, uint32_t v) { put16(p, v & 0xffff); put16(p + 2, v >> 16); }

typedef struct {
  int64_t offset, csize, usize;
  uint32_t crc;
  uint16_t method;
  bool directory;
  mode_t mode;
  time_t mtime;
  const char *name;
  size_t name_len;
} ZipItem;

static int cmp_zip_item(const void *a, const void *b) {
  int64_t x = ((const ZipItem *)a)->offset, y = ((const ZipItem *)b)->offset;
  return x < y ? -1 : x > y;
}

static time_t dos_time(uint16_t time, uint16_t date) {
  struct tm tm;
  memset(&tm, 0, sizeof(tm));
  tm.tm_sec = (time & 0x1f) * 2;
  tm.tm_min = (time >> 5) & 0x3f;
  tm.tm_hour = time >> 11;
  tm.tm_mday = (date & 0x1f) ? (date & 0x1f) : 1;
  tm.tm_mon = ((date >> 5) & 0x0f) ? ((date >> 5) & 0x0f) - 1 : 0;
  tm.tm_year = (date >> 9) + 80;
  time_t value = timegm(&tm);
  return value < 0 ? 0 : value;
}

static void extract_zip(Extract *x, int fd, int64_t size) {
  require_codec(XC_DEFLATE);
  if (size < 22) archive_malformed();
  size_t tail = size < 65557 ? (size_t)size : 65557;
  unsigned char *t = malloc(tail);
  if (!t) _exit(12);
  pread_exact(fd, t, tail, size - (int64_t)tail);
  ssize_t e = -1;
  for (ssize_t i = (ssize_t)tail - 22; i >= 0; i--) {
    if (le32(t + i) == 0x06054b50 && (size_t)i + 22 + le16(t + i + 20) == tail) { e = i; break; }
  }
  if (e < 0) archive_malformed();
  int64_t directory_end = size - (int64_t)tail + e;
  uint64_t count = le16(t + e + 10), cd_size = le32(t + e + 12), cd_offset = le32(t + e + 16);
  if (le16(t + e + 4) != 0 || le16(t + e + 6) != 0 || le16(t + e + 8) != count) {
    respond_error("VALIDATION", EINVAL, "multi-volume zip archives are not supported");
  }
  if (count == 0xffff || cd_size == 0xffffffffu || cd_offset == 0xffffffffu) {
    if (e < 20 || le32(t + e - 20) != 0x07064b50) archive_malformed();
    uint64_t record = le64(t + e - 20 + 8);
    unsigned char z64[56];
    if (record > (uint64_t)directory_end || (uint64_t)directory_end - record < 56) archive_malformed();
    pread_exact(fd, z64, 56, (int64_t)record);
    if (le32(z64) != 0x06064b50) archive_malformed();
    count = le64(z64 + 32);
    cd_size = le64(z64 + 40);
    cd_offset = le64(z64 + 48);
    directory_end = (int64_t)record;
  }
  free(t);
  if (count > (uint64_t)x->max_entries) respond_error("LIMIT_EXCEEDED", EFBIG, XP_ARCHIVE_LIMIT_MESSAGE);
  if (cd_size > XP_MAX_ZIP_DIRECTORY_BYTES) respond_error("LIMIT_EXCEEDED", EFBIG, "zip central directory exceeds its size limit");
  if (cd_offset > (uint64_t)directory_end || cd_size > (uint64_t)directory_end - cd_offset) archive_malformed();
  unsigned char *cd = malloc(cd_size ? cd_size : 1);
  ZipItem *items = calloc(count ? count : 1, sizeof(ZipItem));
  if (!cd || !items) _exit(12);
  pread_exact(fd, cd, cd_size, (int64_t)cd_offset);
  size_t pos = 0;
  int64_t declared = 0;
  for (uint64_t i = 0; i < count; i++) {
    if (pos + 46 > cd_size || le32(cd + pos) != 0x02014b50) archive_malformed();
    const unsigned char *p = cd + pos;
    uint16_t made_by = le16(p + 4), flags = le16(p + 8), method = le16(p + 10);
    uint16_t name_len = le16(p + 28), extra_len = le16(p + 30), comment_len = le16(p + 32);
    uint64_t csize = le32(p + 20), usize = le32(p + 24), offset = le32(p + 42);
    uint32_t attributes = le32(p + 38);
    if (pos + 46 + name_len + extra_len + comment_len > cd_size) archive_malformed();
    for (const unsigned char *q = p + 46 + name_len, *end = q + extra_len; q + 4 <= end; ) {
      uint16_t id = le16(q), len = le16(q + 2);
      const unsigned char *data = q + 4, *stop = data + len;
      if (stop > end) archive_malformed();
      if (id == 0x0001) {
        if (usize == 0xffffffffu) { if (data + 8 > stop) archive_malformed(); usize = le64(data); data += 8; }
        if (csize == 0xffffffffu) { if (data + 8 > stop) archive_malformed(); csize = le64(data); data += 8; }
        if (offset == 0xffffffffu) { if (data + 8 > stop) archive_malformed(); offset = le64(data); }
      }
      q = stop;
    }
    if (flags & 0x41) respond_error("VALIDATION", EINVAL, "encrypted zip entries are not supported");
    if (method != 0 && method != 8) respond_error("VALIDATION", EINVAL, "zip entry uses an unsupported compression method");
    if ((method == 0 && csize != usize) || usize > (uint64_t)INT64_MAX || csize > (uint64_t)size || offset > (uint64_t)size) archive_malformed();
    bool unix_mode = (made_by >> 8) == 3 || (made_by >> 8) == 19;
    mode_t mode = unix_mode ? (mode_t)(attributes >> 16) : 0;
    bool directory = name_len > 0 && p[46 + name_len - 1] == '/';
    if (unix_mode && (mode & S_IFMT) != 0) {
      if (S_ISLNK(mode)) respond_error("FORBIDDEN", ELOOP, "archive contains a link; links are not extracted");
      if (S_ISDIR(mode)) directory = true;
      else if (!S_ISREG(mode)) respond_error("FORBIDDEN", EACCES, "archive contains a device or FIFO entry");
    } else if (!unix_mode && (attributes & 0x10)) {
      directory = true;
    }
    mode &= 07777;
    items[i] = (ZipItem){ .offset = (int64_t)offset, .csize = (int64_t)csize, .usize = (int64_t)usize, .crc = le32(p + 16),
      .method = method, .directory = directory, .mode = mode ? mode : (directory ? 0750 : 0640),
      .mtime = dos_time(le16(p + 12), le16(p + 14)), .name = (const char *)p + 46, .name_len = name_len };
    if ((int64_t)usize > x->max_bytes - declared) respond_error("LIMIT_EXCEEDED", EFBIG, XP_ARCHIVE_LIMIT_MESSAGE);
    declared += (int64_t)usize;
    pos += 46 + (size_t)name_len + extra_len + comment_len;
  }
  if (declared > XP_ARCHIVE_RATIO_FLOOR && declared / XP_MAX_ARCHIVE_RATIO > size) {
    respond_error("LIMIT_EXCEEDED", EFBIG, "archive expands beyond the decompression ratio limit");
  }
  qsort(items, count, sizeof(ZipItem), cmp_zip_item);
  for (uint64_t i = 0; i < count; i++) {
    ZipItem *item = &items[i];
    /* Entries may not share or overlap their data, which defeats overlapping-entry zip bombs. */
    int64_t boundary = i + 1 < count ? items[i + 1].offset : (int64_t)cd_offset;
    unsigned char local[30];
    if (item->offset > boundary || boundary - item->offset < 30) archive_malformed();
    pread_exact(fd, local, 30, item->offset);
    if (le32(local) != 0x04034b50) archive_malformed();
    int64_t data = item->offset + 30 + le16(local + 26) + le16(local + 28);
    if (data > boundary || item->csize > boundary - data) archive_malformed();
    char path[XP_MAX_PATH_BYTES + 1];
    bool slash = false;
    if (!archive_entry_name(item->name, item->name_len, path, &slash)) continue;
    if (item->directory || slash) {
      extract_dir(x, path, item->mode);
      continue;
    }
    int out = extract_file_open(x, path, item->usize);
    Reader *r = calloc(1, sizeof(Reader));
    if (!r) _exit(12);
    reader_open(r, item->method == 8 ? XC_DEFLATE : XC_NONE, fd, data, item->csize, 0);
    unsigned long crc = 0;
    int64_t total = 0;
    for (;;) {
      size_t n = reader_read(r, (unsigned char *)g_copy_buffer, sizeof(g_copy_buffer));
      if (n == 0) break;
      if ((int64_t)n > item->usize - total) archive_malformed();
      total += (int64_t)n;
      crc = g_codec.crc32(crc, (const unsigned char *)g_copy_buffer, (unsigned int)n);
      extract_write(x, out, (const unsigned char *)g_copy_buffer, n);
    }
    reader_close(r);
    free(r);
    if (total != item->usize || (uint32_t)crc != item->crc) archive_malformed();
    extract_file_close(out, item->mode, item->mtime);
  }
  free(items);
  free(cd);
}

/* A compressed single file (.gz, .bz2, .zst) becomes one file named without that suffix. */
static void extract_single(Extract *x, Reader *r, const char *archive_name, const unsigned char *first, size_t first_len, time_t mtime) {
  static const char *const suffixes[] = { ".gz", ".bz2", ".zst" };
  char name[NAME_MAX + 1] = "";
  size_t len = strlen(archive_name);
  for (size_t i = 0; i < sizeof(suffixes) / sizeof(suffixes[0]); i++) {
    size_t s = strlen(suffixes[i]);
    if (len > s && strcasecmp(archive_name + len - s, suffixes[i]) == 0) {
      memcpy(name, archive_name, len - s);
      name[len - s] = '\0';
    }
  }
  if (!name[0]) respond_error("VALIDATION", EINVAL, "a compressed single file must end in .gz, .bz2 or .zst");
  char path[XP_MAX_PATH_BYTES + 1];
  bool directory = false;
  if (!archive_entry_name(name, strlen(name), path, &directory) || directory) respond_error("VALIDATION", EINVAL, "the extracted file name is not valid");
  int fd = extract_file_open(x, path, 0);
  extract_write(x, fd, first, first_len);
  for (;;) {
    size_t n = reader_read(r, (unsigned char *)g_copy_buffer, sizeof(g_copy_buffer));
    if (n == 0) break;
    extract_write(x, fd, (const unsigned char *)g_copy_buffer, n);
  }
  extract_file_close(fd, 0640, mtime);
}

static int64_t archive_byte_ceiling(void) {
  return g_archive_quota_bytes > 0 && g_archive_quota_bytes < XP_MAX_ARCHIVE_BYTES ? g_archive_quota_bytes : XP_MAX_ARCHIVE_BYTES;
}

static void start_staging(int parent_fd, bool directory) {
  char rand_hex[17];
  generate_random_hex(rand_hex);
  snprintf(g_staging.name, sizeof(g_staging.name), ".xpanel-tmp-%d-%s", (int)getpid(), rand_hex);
  g_staging.parent_fd = parent_fd;
  int rc = directory ? mkdirat(parent_fd, g_staging.name, 0700)
                     : xp_openat2(parent_fd, g_staging.name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600, XP_RESOLVE_CONFINED);
  if (rc < 0) respond_errno(errno, "create archive staging entry failed");
  g_staging.active = true;
  if (!directory) close(rc);
}

/* Moves each staged top-level entry into an existing folder. Nothing is published while any name is taken. */
static void publish_staged_children(int staging_fd, int dest_fd) {
  int scan_fd = dup(staging_fd);
  DIR *dirp = scan_fd < 0 ? NULL : fdopendir(scan_fd);
  if (!dirp) respond_errno(errno, "read archive staging folder failed");
  StrBuf names;
  sb_init(&names, 1024);
  size_t count = 0;
  for (;;) {
    errno = 0;
    struct dirent *de = readdir(dirp);
    if (!de) {
      if (errno != 0) respond_errno(errno, "read archive staging folder failed");
      break;
    }
    if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0) continue;
    struct stat st;
    if (fstatat(dest_fd, de->d_name, &st, AT_SYMLINK_NOFOLLOW) == 0) respond_error("CONFLICT", EEXIST, "an item from the archive already exists in the destination folder");
    if (errno != ENOENT) respond_errno(errno, "inspect destination folder failed");
    sb_append_mem(&names, de->d_name, strlen(de->d_name) + 1);
    count++;
  }
  closedir(dirp);
  const char *name = names.data;
  for (size_t i = 0; i < count; i++, name += strlen(name) + 1) {
    if (xp_renameat2(staging_fd, name, dest_fd, name, RENAME_NOREPLACE) != 0) {
      if (i == 0) respond_errno(errno, "publish extracted entry failed");
      respond_error("SERVICE_UNAVAILABLE", errno, "extraction was partly published; outcome requires inspection");
    }
  }
  free(names.data);
}

static void op_extract(int home_dirfd, uid_t uid, const JsonVal *req, int64_t max_list_entries) {
  const char *path = NULL, *destination = NULL;
  size_t path_len = 0, destination_len = 0;
  if (!jv_get_str(req, "path", &path, &path_len) || !jv_get_str(req, "destination", &destination, &destination_len)) {
    respond_error("VALIDATION", EINVAL, "extract requires path and destination");
  }
  assert_safe_rel_path(path, path_len, false);
  assert_safe_rel_path(destination, destination_len, true);
  char archive_parent[XP_MAX_PATH_BYTES + 1], archive_name[NAME_MAX + 1];
  split_rel_path(path, archive_parent, archive_name);
  int archive_dir = open_confined_dir(home_dirfd, archive_parent, uid);
  int afd = xp_openat2(archive_dir, archive_name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK, 0, XP_RESOLVE_CONFINED);
  if (afd < 0) respond_errno(errno, "open archive failed");
  struct stat ast;
  if (fstat(afd, &ast) != 0) respond_errno(errno, "inspect archive failed");
  if (!S_ISREG(ast.st_mode)) respond_error("FORBIDDEN", EACCES, "only a regular file can be extracted");
  if (ast.st_uid != uid) respond_error("FORBIDDEN", EACCES, "archive owner UID does not match account UID");
  if (ast.st_nlink > 1) respond_error("FORBIDDEN", EMLINK, "hardlinked files cannot be extracted");

  bool exists = true;
  int dest_fd = -1, stage_parent = -1;
  char dest_name[NAME_MAX + 1] = "";
  if (destination_len == 0) {
    dest_fd = open_confined_dir(home_dirfd, "", uid);
    stage_parent = dest_fd;
  } else {
    char dest_parent[XP_MAX_PATH_BYTES + 1];
    split_rel_path(destination, dest_parent, dest_name);
    int parent_fd = open_confined_dir(home_dirfd, dest_parent, uid);
    struct stat dst;
    if (fstatat(parent_fd, dest_name, &dst, AT_SYMLINK_NOFOLLOW) == 0) {
      dest_fd = open_confined_dir(home_dirfd, destination, uid);
      stage_parent = dest_fd;
    } else if (errno == ENOENT) {
      exists = false;
      stage_parent = parent_fd;
    } else {
      respond_errno(errno, "inspect destination failed");
    }
  }

  start_staging(stage_parent, true);
  int root = xp_openat2(stage_parent, g_staging.name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0, XP_RESOLVE_CONFINED);
  if (root < 0) respond_errno(errno, "open archive staging folder failed");
  Extract x = { .root_fd = root, .parent_fd = -1, .max_entries = max_list_entries, .max_bytes = archive_byte_ceiling() };
  unsigned char head[4] = { 0 };
  if (ast.st_size >= 4) pread_exact(afd, head, 4, 0);
  if (head[0] == 'P' && head[1] == 'K' && ((head[2] == 3 && head[3] == 4) || (head[2] == 5 && head[3] == 6))) {
    extract_zip(&x, afd, ast.st_size);
  } else {
    Codec codec = head[0] == 0x1f && head[1] == 0x8b ? XC_GZIP
      : head[0] == 'B' && head[1] == 'Z' && head[2] == 'h' ? XC_BZIP2
      : head[0] == 0x28 && head[1] == 0xb5 && head[2] == 0x2f && head[3] == 0xfd ? XC_ZSTD : XC_NONE;
    Reader *r = calloc(1, sizeof(Reader));
    if (!r) _exit(12);
    reader_open(r, codec, afd, 0, ast.st_size, codec == XC_NONE ? 0 : ast.st_size);
    unsigned char first[512];
    size_t n = reader_full(r, first, sizeof(first));
    if (n == sizeof(first) && tar_checksum_ok(first)) extract_tar(&x, r, first);
    else if (codec == XC_NONE) respond_error("VALIDATION", EINVAL, "the file is not a supported archive");
    else extract_single(&x, r, archive_name, first, n, ast.st_mtim.tv_sec);
    reader_close(r);
    free(r);
  }
  if (syncfs(root) != 0) respond_errno(errno, "syncfs extraction failed");
  if (!exists) {
    if (fchmod(root, 0750) != 0) respond_errno(errno, "set extraction folder mode failed");
    if (xp_renameat2(stage_parent, g_staging.name, stage_parent, dest_name, RENAME_NOREPLACE) != 0) respond_errno(errno, "publish extraction failed");
    g_staging.active = false;
  } else {
    publish_staged_children(root, dest_fd);
    g_staging.active = false;
    (void)unlinkat(stage_parent, g_staging.name, AT_REMOVEDIR);
  }
  (void)fsync(stage_parent);
  StrBuf sb;
  sb_init(&sb, 256);
  sb_append_str(&sb, "{\"destination\":");
  sb_append_json_str(&sb, destination, destination_len);
  sb_append_fmt(&sb, ",\"entries\":%" PRId64 ",\"bytes\":%" PRId64 "}", x.entries, x.bytes);
  respond_success_raw(sb.data);
}

/* --- Compression --- */

typedef struct {
  bool zip;
  int fd;
  Writer w;
  Writer entry;
  int64_t offset, entry_offset, usize;
  unsigned long crc;
  StrBuf central;
  uint32_t central_count;
} ArchiveOut;

static void tar_number_field(unsigned char *field, size_t len, uint64_t value) {
  memset(field, '0', len - 1);
  field[len - 1] = '\0';
  for (size_t i = len - 1; i-- > 0 && value; value >>= 3) field[i] = (unsigned char)('0' + (value & 7));
}

static size_t decimal_digits(size_t value) {
  size_t digits = 1;
  while (value >= 10) { value /= 10; digits++; }
  return digits;
}

static void tar_write_header(Writer *w, const char *name, size_t name_len, char type, mode_t mode, int64_t size, time_t mtime) {
  unsigned char h[512];
  if (name_len > 100) {
    /* Names longer than the ustar field travel in a pax "path" record, which every current tar reads. */
    size_t base = strlen(" path=") + name_len + 1, record = base + decimal_digits(base);
    if (decimal_digits(record) != decimal_digits(base)) record++;
    char *pax = malloc(record + 1);
    if (!pax) _exit(12);
    int written = snprintf(pax, record + 1, "%zu path=%s\n", record, name);
    if (written < 0 || (size_t)written != record) respond_error("CONFIG_TEST_FAILED", EINVAL, "archive header encoding failed");
    tar_write_header(w, "PaxHeader", 9, 'x', 0640, (int64_t)record, mtime);
    writer_put(w, pax, record, false);
    memset(h, 0, sizeof(h));
    writer_put(w, h, (512 - record % 512) % 512, false);
    free(pax);
    name_len = 100;
  }
  memset(h, 0, sizeof(h));
  memcpy(h, name, name_len);
  tar_number_field(h + 100, 8, mode & 0777);
  tar_number_field(h + 108, 8, getuid());
  tar_number_field(h + 116, 8, getgid());
  tar_number_field(h + 124, 12, (uint64_t)size);
  tar_number_field(h + 136, 12, mtime > 0 ? (uint64_t)mtime : 0);
  h[156] = (unsigned char)type;
  memcpy(h + 257, "ustar", 6);
  memcpy(h + 263, "00", 2);
  memset(h + 148, ' ', 8);
  unsigned int sum = 0;
  for (int i = 0; i < 512; i++) sum += h[i];
  tar_number_field(h + 148, 7, sum);
  writer_put(w, h, sizeof(h), false);
}

static void dos_stamp(time_t when, uint16_t *time_out, uint16_t *date_out) {
  struct tm tm;
  memset(&tm, 0, sizeof(tm));
  gmtime_r(&when, &tm);
  if (tm.tm_year < 80) { tm.tm_year = 80; tm.tm_mon = 0; tm.tm_mday = 1; tm.tm_hour = tm.tm_min = tm.tm_sec = 0; }
  *time_out = (uint16_t)((tm.tm_hour << 11) | (tm.tm_min << 5) | (tm.tm_sec / 2));
  *date_out = (uint16_t)(((tm.tm_year - 80) << 9) | ((tm.tm_mon + 1) << 5) | tm.tm_mday);
}

static void archive_entry_begin(ArchiveOut *o, const char *name, size_t name_len, bool directory, const struct stat *st) {
  if (!o->zip) {
    tar_write_header(&o->w, name, name_len, directory ? '5' : '0', st->st_mode, directory ? 0 : (int64_t)st->st_size, st->st_mtim.tv_sec);
    return;
  }
  uint16_t dtime, ddate;
  dos_stamp(st->st_mtim.tv_sec, &dtime, &ddate);
  unsigned char local[30];
  memset(local, 0, sizeof(local));
  put32(local, 0x04034b50);
  put16(local + 4, 20);
  put16(local + 6, 0x0800);
  put16(local + 8, directory ? 0 : 8);
  put16(local + 10, dtime);
  put16(local + 12, ddate);
  put16(local + 26, (uint32_t)name_len);
  o->entry_offset = o->offset;
  write_fd_all(o->fd, local, sizeof(local));
  write_fd_all(o->fd, name, name_len);
  o->offset += 30 + (int64_t)name_len;
  o->crc = 0;
  o->usize = 0;
  if (!directory) writer_open(&o->entry, XC_DEFLATE, o->fd);
}

static void archive_entry_data(ArchiveOut *o, const unsigned char *data, size_t n) {
  if (!o->zip) {
    writer_put(&o->w, data, n, false);
    return;
  }
  o->crc = g_codec.crc32(o->crc, data, (unsigned int)n);
  o->usize += (int64_t)n;
  writer_put(&o->entry, data, n, false);
}

static void archive_entry_end(ArchiveOut *o, const char *name, size_t name_len, bool directory, const struct stat *st) {
  if (!o->zip) {
    static const unsigned char zeros[512];
    if (!directory) writer_put(&o->w, zeros, (512 - (size_t)(st->st_size % 512)) % 512, false);
    return;
  }
  int64_t csize = 0;
  if (!directory) {
    writer_close(&o->entry);
    csize = o->entry.written;
  }
  o->offset += csize;
  unsigned char sizes[12];
  put32(sizes, (uint32_t)o->crc);
  put32(sizes + 4, (uint32_t)csize);
  put32(sizes + 8, (uint32_t)o->usize);
  if (pwrite(o->fd, sizes, sizeof(sizes), (off_t)o->entry_offset + 14) != (ssize_t)sizeof(sizes)) respond_errno(errno ? errno : EIO, "write archive output failed");
  uint16_t dtime, ddate;
  dos_stamp(st->st_mtim.tv_sec, &dtime, &ddate);
  unsigned char c[46];
  memset(c, 0, sizeof(c));
  put32(c, 0x02014b50);
  put16(c + 4, (3 << 8) | 30);
  put16(c + 6, 20);
  put16(c + 8, 0x0800);
  put16(c + 10, directory ? 0 : 8);
  put16(c + 12, dtime);
  put16(c + 14, ddate);
  memcpy(c + 16, sizes, sizeof(sizes));
  put16(c + 28, (uint32_t)name_len);
  put32(c + 38, ((uint32_t)((directory ? S_IFDIR : S_IFREG) | (st->st_mode & 0777)) << 16) | (directory ? 0x10 : 0));
  put32(c + 42, (uint32_t)o->entry_offset);
  sb_append_mem(&o->central, (const char *)c, sizeof(c));
  sb_append_mem(&o->central, name, name_len);
  o->central_count++;
  if (o->central.len > XP_MAX_ZIP_DIRECTORY_BYTES) respond_error("LIMIT_EXCEEDED", EFBIG, "zip central directory exceeds its size limit");
}

static void archive_finish(ArchiveOut *o) {
  if (!o->zip) {
    static const unsigned char zeros[1024];
    writer_put(&o->w, zeros, sizeof(zeros), false);
    writer_close(&o->w);
    return;
  }
  write_fd_all(o->fd, o->central.data, o->central.len);
  unsigned char end[22];
  memset(end, 0, sizeof(end));
  put32(end, 0x06054b50);
  put16(end + 8, o->central_count);
  put16(end + 10, o->central_count);
  put32(end + 12, (uint32_t)o->central.len);
  put32(end + 16, (uint32_t)o->offset);
  write_fd_all(o->fd, end, sizeof(end));
}

/* Adds one entry (recursively for a folder); rel holds its archive name and is restored on return. */
static void archive_add(ArchiveOut *o, int parent_fd, const char *name, char *rel, size_t rel_len, uid_t uid, int depth, CopyBudget *budget) {
  if (depth > XP_MAX_TREE_DEPTH) respond_error("LIMIT_EXCEEDED", ELOOP, "directory nesting exceeds the archive limit");
  int fd = xp_openat2(parent_fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK, 0, XP_RESOLVE_CONFINED);
  if (fd < 0) respond_errno(errno, "open archive source failed");
  struct stat st;
  if (fstat(fd, &st) != 0) respond_errno(errno, "inspect archive source failed");
  require_managed_entry(&st, uid);
  if (!copy_budget_add(budget, 1, S_ISREG(st.st_mode) ? (int64_t)st.st_size : 0)) respond_error("LIMIT_EXCEEDED", EFBIG, budget->limit_message);
  if (S_ISDIR(st.st_mode)) {
    if (rel_len + 1 > XP_MAX_PATH_BYTES) respond_error("LIMIT_EXCEEDED", ENAMETOOLONG, "archive entry path is too long");
    rel[rel_len] = '/';
    rel[rel_len + 1] = '\0';
    archive_entry_begin(o, rel, rel_len + 1, true, &st);
    archive_entry_end(o, rel, rel_len + 1, true, &st);
    DIR *dirp = fdopendir(fd);
    if (!dirp) respond_errno(errno, "read archive source folder failed");
    for (;;) {
      errno = 0;
      struct dirent *de = readdir(dirp);
      if (!de) {
        if (errno != 0) respond_errno(errno, "read archive source folder failed");
        break;
      }
      if (skipped_tree_name(de->d_name)) continue;
      size_t child_len = strlen(de->d_name);
      if (rel_len + 1 + child_len > XP_MAX_PATH_BYTES) respond_error("LIMIT_EXCEEDED", ENAMETOOLONG, "archive entry path is too long");
      memcpy(rel + rel_len + 1, de->d_name, child_len + 1);
      archive_add(o, dirfd(dirp), de->d_name, rel, rel_len + 1 + child_len, uid, depth + 1, budget);
    }
    closedir(dirp);
    rel[rel_len] = '\0';
    return;
  }
  archive_entry_begin(o, rel, rel_len, false, &st);
  int64_t total = 0;
  for (;;) {
    ssize_t n = read(fd, g_copy_buffer, sizeof(g_copy_buffer));
    if (n < 0) {
      if (errno == EINTR) continue;
      respond_errno(errno, "read archive source failed");
    }
    if (n == 0) break;
    if (n > st.st_size - total) break;
    total += n;
    archive_entry_data(o, (const unsigned char *)g_copy_buffer, (size_t)n);
  }
  if (total != st.st_size) respond_error("CONFLICT", EAGAIN, "a file changed while it was being archived");
  archive_entry_end(o, rel, rel_len, false, &st);
  close(fd);
}

/* Maps the archive name's suffix to its format, so a name always tells the truth about its content. */
static bool archive_format(const char *name, bool *zip, Codec *codec) {
  static const struct { const char *suffix; bool zip; Codec codec; } formats[] = {
    { ".zip", true, XC_DEFLATE }, { ".tar", false, XC_NONE }, { ".tar.gz", false, XC_GZIP }, { ".tgz", false, XC_GZIP },
    { ".tar.bz2", false, XC_BZIP2 }, { ".tbz2", false, XC_BZIP2 }, { ".tar.zst", false, XC_ZSTD }, { ".tzst", false, XC_ZSTD },
  };
  size_t len = strlen(name);
  for (size_t i = 0; i < sizeof(formats) / sizeof(formats[0]); i++) {
    size_t s = strlen(formats[i].suffix);
    if (len > s && strcasecmp(name + len - s, formats[i].suffix) == 0) {
      *zip = formats[i].zip;
      *codec = formats[i].codec;
      return true;
    }
  }
  return false;
}

static int compare_names(const void *left, const void *right) {
  return strcmp(*(const char *const *)left, *(const char *const *)right);
}

/* A file manager selection: every path lies in one folder and becomes a top-level entry under its own name. */
static void op_compress(int home_dirfd, uid_t uid, const JsonVal *req, int64_t max_file_mode, int64_t max_list_entries) {
  const JsonVal *paths = jv_get(req, "paths");
  const char *destination = NULL;
  size_t destination_len = 0;
  if (!paths || paths->kind != JV_ARRAY || paths->prop_count == 0 || !jv_get_str(req, "destination", &destination, &destination_len)) {
    respond_error("VALIDATION", EINVAL, "compress requires paths and destination");
  }
  if (paths->prop_count > (size_t)max_list_entries) respond_error("LIMIT_EXCEEDED", EFBIG, XP_ARCHIVE_LIMIT_MESSAGE);
  assert_safe_rel_path(destination, destination_len, false);
  ArchiveOut *o = calloc(1, sizeof(ArchiveOut));
  if (!o) _exit(12);
  Codec codec = XC_NONE;
  if (!archive_format(destination, &o->zip, &codec)) {
    respond_error("VALIDATION", EINVAL, "archive name must end in .zip, .tar, .tar.gz, .tgz, .tar.bz2, .tbz2, .tar.zst or .tzst");
  }
  require_codec(codec);
  size_t count = paths->prop_count;
  const char **names = calloc(count, sizeof(char *));
  if (!names) _exit(12);
  char src_parent[XP_MAX_PATH_BYTES + 1], parent[XP_MAX_PATH_BYTES + 1], name[NAME_MAX + 1];
  for (size_t i = 0; i < count; i++) {
    const JsonVal *item = paths->props[i].val;
    if (item->kind != JV_STRING) respond_error("VALIDATION", EINVAL, "compress paths must be strings");
    assert_safe_rel_path(item->str_val, item->str_len, false);
    if (rel_path_within(destination, item->str_val)) respond_error("VALIDATION", EINVAL, "destination must not be the source or inside it");
    split_rel_path(item->str_val, i == 0 ? src_parent : parent, name);
    if (i > 0 && strcmp(parent, src_parent) != 0) respond_error("VALIDATION", EINVAL, "compressed items must share one folder");
    const char *slash = strrchr(item->str_val, '/');
    names[i] = slash ? slash + 1 : item->str_val;
  }
  qsort(names, count, sizeof(char *), compare_names);
  for (size_t i = 1; i < count; i++) {
    if (strcmp(names[i - 1], names[i]) == 0) respond_error("VALIDATION", EINVAL, "compressed items must be distinct");
  }
  char dst_parent[XP_MAX_PATH_BYTES + 1], dst_name[NAME_MAX + 1];
  split_rel_path(destination, dst_parent, dst_name);
  int src_fd = open_confined_dir(home_dirfd, src_parent, uid);
  int dst_fd = open_confined_dir(home_dirfd, dst_parent, uid);
  struct stat existing;
  if (fstatat(dst_fd, dst_name, &existing, AT_SYMLINK_NOFOLLOW) == 0) respond_error("CONFLICT", EEXIST, "archive destination already exists");
  if (errno != ENOENT) respond_errno(errno, "fstatat archive destination failed");
  CopyBudget scanned = { .entries = 0, .bytes = 0, .max_entries = max_list_entries, .max_bytes = archive_byte_ceiling(), .limit_message = XP_ARCHIVE_LIMIT_MESSAGE };
  for (size_t i = 0; i < count; i++) scan_copy_source(src_fd, names[i], uid, 0, &scanned);

  start_staging(dst_fd, false);
  o->fd = xp_openat2(dst_fd, g_staging.name, O_WRONLY | O_NOFOLLOW, 0, XP_RESOLVE_CONFINED);
  if (o->fd < 0) respond_errno(errno, "open archive staging file failed");
  if (o->zip) sb_init(&o->central, 4096);
  else writer_open(&o->w, codec, o->fd);
  char rel[XP_MAX_PATH_BYTES + 2];
  CopyBudget budget = scanned;
  budget.entries = budget.bytes = 0;
  for (size_t i = 0; i < count; i++) {
    snprintf(rel, sizeof(rel), "%s", names[i]);
    archive_add(o, src_fd, names[i], rel, strlen(rel), uid, 0, &budget);
  }
  archive_finish(o);
  if (fchmod(o->fd, (mode_t)(max_file_mode & 0640)) != 0) respond_errno(errno, "set archive mode failed");
  if (fsync(o->fd) != 0) respond_errno(errno, "fsync archive failed");
  close(o->fd);
  if (xp_renameat2(dst_fd, g_staging.name, dst_fd, dst_name, RENAME_NOREPLACE) != 0) respond_errno(errno, "publish archive failed");
  g_staging.active = false;
  (void)fsync(dst_fd);
  respond_entry_at(dst_fd, dst_name, destination);
}

static void run_operation(const char *op, int home_dirfd, uid_t uid, const JsonVal *req, int64_t max_edit_bytes,
                          int64_t max_file_mode, int64_t max_dir_mode, int64_t max_list_entries) {
  if (strcmp(op, "list") == 0) {
    op_list(home_dirfd, uid, req, max_list_entries);
  } else if (strcmp(op, "read") == 0) {
    op_read(home_dirfd, uid, req, max_edit_bytes);
  } else if (strcmp(op, "write") == 0) {
    op_write(home_dirfd, uid, req, max_edit_bytes, max_file_mode);
  } else if (strcmp(op, "write-checked") == 0) {
    op_write_checked(home_dirfd, uid, req, max_edit_bytes, max_file_mode);
  } else if (strcmp(op, "put-bytes") == 0) {
    op_put_bytes(home_dirfd, uid, req, max_file_mode);
  } else if (strcmp(op, "get-bytes") == 0) {
    op_get_bytes(home_dirfd, uid, req);
  } else if (strcmp(op, "mkdir") == 0) {
    op_mkdir(home_dirfd, uid, req, max_dir_mode);
  } else if (strcmp(op, "chmod") == 0) {
    op_chmod(home_dirfd, uid, req, max_file_mode, max_dir_mode);
  } else if (strcmp(op, "move") == 0) {
    op_move(home_dirfd, uid, req);
  } else if (strcmp(op, "copy") == 0) {
    op_copy(home_dirfd, uid, req, max_file_mode, max_dir_mode, max_list_entries);
  } else if (strcmp(op, "compress") == 0) {
    op_compress(home_dirfd, uid, req, max_file_mode, max_list_entries);
  } else if (strcmp(op, "extract") == 0) {
    op_extract(home_dirfd, uid, req, max_list_entries);
  } else if (strcmp(op, "trash") == 0) {
    op_trash(home_dirfd, uid, req);
  } else if (strcmp(op, "list-trash") == 0) {
    op_list_trash(home_dirfd, uid, max_list_entries);
  } else if (strcmp(op, "restore") == 0) {
    op_restore(home_dirfd, uid, req, max_file_mode, max_dir_mode);
  } else if (strcmp(op, "empty-trash") == 0) {
    op_empty_trash(home_dirfd, uid, req);
  } else if (strcmp(op, "purge-trash") == 0) {
    op_purge_trash(home_dirfd, uid, req);
  } else {
    respond_error("VALIDATION", EINVAL, "unsupported account file operation");
  }
}

int main(int argc, char **argv) {
  (void)argv;
  close_extra_fds();
  refresh_worker_state();
  snprintf(g_worker.op, sizeof(g_worker.op), "init");

  if (argc != 1) {
    respond_error("VALIDATION", EINVAL, "xpanel-account-files accepts no command-line arguments");
  }

  size_t cap = 65536;
  char *input = calloc(1, cap + 1);
  if (!input) _exit(12);
  size_t total = 0;
  while (true) {
    if (total == cap) {
      if (cap >= XP_MAX_STDIN_BYTES + 1) {
        respond_error("LIMIT_EXCEEDED", E2BIG, "request exceeds maximum stdin size");
      }
      size_t next = cap * 2;
      if (next > XP_MAX_STDIN_BYTES + 1) next = XP_MAX_STDIN_BYTES + 1;
      char *np = realloc(input, next + 1);
      if (!np) _exit(12);
      input = np;
      cap = next;
    }
    ssize_t n = read(STDIN_FILENO, input + total, cap - total);
    if (n < 0) {
      if (errno == EINTR) continue;
      respond_errno(errno, "read stdin failed");
    }
    if (n == 0) break;
    total += (size_t)n;
    if (total > XP_MAX_STDIN_BYTES) {
      respond_error("LIMIT_EXCEEDED", E2BIG, "request exceeds maximum stdin size");
    }
  }
  input[total] = '\0';

  if (total == 0 || !is_valid_utf8(input, total)) {
    respond_error("VALIDATION", EINVAL, "stdin request must be non-empty valid UTF-8 JSON");
  }

  JsonParser parser = {.src = input, .len = total, .pos = 0};
  JsonVal *root = jp_parse_value(&parser, 0);
  jp_skip_ws(&parser);
  if (!root || root->kind != JV_OBJECT || parser.pos != parser.len) {
    respond_error("VALIDATION", EINVAL, "request body must be a single valid JSON object");
  }

  int64_t proto = 0;
  if (!jv_get_int(root, "protocolVersion", &proto) || proto != XP_PROTOCOL_VERSION) {
    respond_error("CONFIG_TEST_FAILED", EPROTO, "unsupported helper protocol version");
  }

  const JsonVal *ctx = jv_get(root, "context");
  const JsonVal *req = jv_get(root, "request");
  if (!ctx || ctx->kind != JV_OBJECT || !req || req->kind != JV_OBJECT) {
    respond_error("VALIDATION", EINVAL, "context and request objects are required");
  }

  const char *op = NULL;
  if (!jv_get_str(req, "op", &op, NULL) || strlen(op) == 0 || strlen(op) >= sizeof(g_worker.op)) {
    respond_error("VALIDATION", EINVAL, "request.op is required");
  }
  snprintf(g_worker.op, sizeof(g_worker.op), "%s", op);

  const char *username = NULL;
  const char *home_root = NULL;
  int64_t uid_i64 = 0, gid_i64 = 0;
  int64_t max_edit_bytes = XP_MAX_EDIT_BYTES_CEILING;
  int64_t max_file_mode = 0640;
  int64_t max_dir_mode = 0750;
  int64_t max_list_entries = XP_MAX_LIST_ENTRIES_CEILING;

  if (!jv_get_str(ctx, "username", &username, NULL) ||
      !jv_get_int(ctx, "uid", &uid_i64) ||
      !jv_get_int(ctx, "gid", &gid_i64) ||
      !jv_get_str(ctx, "homeRoot", &home_root, NULL)) {
    respond_error("VALIDATION", EINVAL, "context requires username, uid, gid, and homeRoot");
  }

  (void)jv_get_int(ctx, "maxEditBytes", &max_edit_bytes);
  (void)jv_get_int(ctx, "maxFileMode", &max_file_mode);
  (void)jv_get_int(ctx, "maxDirMode", &max_dir_mode);
  (void)jv_get_int(ctx, "maxListEntries", &max_list_entries);
  int64_t disk_quota_mb = 0;
  if (jv_get_int(ctx, "diskQuotaMb", &disk_quota_mb) && disk_quota_mb > 0 && disk_quota_mb <= XP_MAX_ARCHIVE_BYTES / (1024 * 1024)) {
    g_archive_quota_bytes = disk_quota_mb * 1024 * 1024;
  }

  if (max_edit_bytes <= 0 || max_edit_bytes > XP_MAX_EDIT_BYTES_CEILING ||
      max_file_mode <= 0 || max_file_mode > 0640 || (max_file_mode & ~0640) != 0 ||
      max_dir_mode <= 0 || max_dir_mode > 0750 || (max_dir_mode & ~0750) != 0 ||
      max_list_entries <= 0 || max_list_entries > XP_MAX_LIST_ENTRIES_CEILING) {
    respond_error("VALIDATION", EINVAL, "context limits exceed helper safety ceilings");
  }

  if (uid_i64 < XP_MIN_ACCOUNT_ID || uid_i64 > XP_MAX_ACCOUNT_ID ||
      gid_i64 < XP_MIN_ACCOUNT_ID || gid_i64 > XP_MAX_ACCOUNT_ID) {
    respond_error("VALIDATION", EINVAL, "account UID and GID must be in 1000..65533");
  }
  uid_t account_uid = (uid_t)uid_i64;
  gid_t account_gid = (gid_t)gid_i64;

  if (geteuid() != 0) {
    respond_error("PRECONDITION_FAILED", EPERM, "xpanel-account-files supervisor must start as root (UID 0)");
  }

  const char *cgroup_path = NULL;
  const char *worker_unit = NULL;
  size_t cgroup_path_len = 0, worker_unit_len = 0;
  bool require_cgroup = false;
  if (!jv_get_bool(ctx, "requireCgroup", &require_cgroup) || !require_cgroup ||
      !jv_get_str(ctx, "cgroupPath", &cgroup_path, &cgroup_path_len) ||
      !jv_get_str(ctx, "workerUnit", &worker_unit, &worker_unit_len) ||
      cgroup_path_len != strlen(cgroup_path) || worker_unit_len != strlen(worker_unit)) {
    respond_error("PRECONDITION_FAILED", EINVAL, "confined systemd file worker context is required");
  }
  int64_t hold_open_ms = 0;
  if (jv_get_int(ctx, "holdOpenMs", &hold_open_ms)) {
    if (hold_open_ms < 0 || hold_open_ms > 2000) {
      respond_error("VALIDATION", EINVAL, "holdOpenMs must be in 0..2000");
    }
    g_worker.hold_open_ms = hold_open_ms;
  }

  /* 1. Verify systemd placement and worker budgets before any tenant home access. */
  verify_account_cgroup(cgroup_path, worker_unit, account_uid);

  /* 2. Open and verify the trusted homeRoot descriptor while still root. */
  int home_dirfd = open_and_verify_home_root(home_root, account_uid, account_gid);

  /* 3. Irreversibly drop supplementary groups, GID, UID, and set PR_SET_NO_NEW_PRIVS */
  drop_privileges_irreversibly(home_dirfd, account_uid, account_gid);

  /* 4. Dispatch operation strictly relative to home_dirfd */
  run_operation(op, home_dirfd, account_uid, req, max_edit_bytes, max_file_mode, max_dir_mode, max_list_entries);
}
