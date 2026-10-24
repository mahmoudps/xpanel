#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
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

static void respond_error(const char *code, int err_num, const char *msg) __attribute__((noreturn));
static void respond_error(const char *code, int err_num, const char *msg) {
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
  sb_append_str(&sb, "}}\n");
  write_all_stdout(sb.data, sb.len);
  free(sb.data);
  maybe_hold_open();
  _exit(0);
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
  JV_OBJECT
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

static JsonVal *jp_parse_value(JsonParser *p, int depth) {
  if (depth > 8) return NULL;
  jp_skip_ws(p);
  if (p->pos >= p->len) return NULL;
  char c = p->src[p->pos];
  if (c == '{') return jp_parse_object(p, depth);
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
    if (strncmp(dname, ".xpanel-tmp-", 12) == 0) continue;
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

static void publish_regular_bytes(int home_dirfd, uid_t uid, const char *path, size_t path_len,
                                  const unsigned char *bytes, size_t nbytes, bool overwrite, int64_t mode,
                                  int64_t max_file_mode) {
  assert_safe_rel_path(path, path_len, false);
  if (mode <= 0 || mode > max_file_mode || (mode & ~max_file_mode) != 0) {
    respond_error("VALIDATION", EINVAL, "regular file mode must not exceed 0640");
  }
  char parent_rel[XP_MAX_PATH_BYTES + 1];
  char base_name[NAME_MAX + 1];
  split_rel_path(path, parent_rel, base_name);

  int parent_fd = open_confined_dir(home_dirfd, parent_rel, uid);

  struct stat existing_st;
  if (fstatat(parent_fd, base_name, &existing_st, AT_SYMLINK_NOFOLLOW) == 0) {
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

  unsigned int rename_flags = overwrite ? 0U : RENAME_NOREPLACE;
  if (xp_renameat2(parent_fd, tmp_name, parent_fd, base_name, rename_flags) != 0) {
    int err = errno;
    (void)unlinkat(parent_fd, tmp_name, 0);
    close(parent_fd);
    respond_errno(err, "renameat2 publish failed");
  }

  (void)fsync(parent_fd);
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
  publish_regular_bytes(home_dirfd, uid, path, path_len, (const unsigned char *)content, content_len, overwrite, mode, max_file_mode);
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
  publish_regular_bytes(home_dirfd, uid, path, path_len, bytes, nbytes, overwrite, mode, max_file_mode);
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
  if (strcmp(op, "list") == 0) {
    op_list(home_dirfd, account_uid, req, max_list_entries);
  } else if (strcmp(op, "read") == 0) {
    op_read(home_dirfd, account_uid, req, max_edit_bytes);
  } else if (strcmp(op, "write") == 0) {
    op_write(home_dirfd, account_uid, req, max_edit_bytes, max_file_mode);
  } else if (strcmp(op, "put-bytes") == 0) {
    op_put_bytes(home_dirfd, account_uid, req, max_file_mode);
  } else if (strcmp(op, "get-bytes") == 0) {
    op_get_bytes(home_dirfd, account_uid, req);
  } else if (strcmp(op, "mkdir") == 0) {
    op_mkdir(home_dirfd, account_uid, req, max_dir_mode);
  } else if (strcmp(op, "chmod") == 0) {
    op_chmod(home_dirfd, account_uid, req, max_file_mode, max_dir_mode);
  } else if (strcmp(op, "trash") == 0) {
    op_trash(home_dirfd, account_uid, req);
  } else if (strcmp(op, "list-trash") == 0) {
    op_list_trash(home_dirfd, account_uid, max_list_entries);
  } else if (strcmp(op, "restore") == 0) {
    op_restore(home_dirfd, account_uid, req, max_file_mode, max_dir_mode);
  } else if (strcmp(op, "empty-trash") == 0) {
    op_empty_trash(home_dirfd, account_uid, req);
  } else {
    respond_error("VALIDATION", EINVAL, "unsupported account file operation");
  }
}
