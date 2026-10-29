/*
 * xpanel-terminal-pty: the PTY bridge behind the agent's terminal sessions.
 *
 * usage: xpanel-terminal-pty <cols> <rows> <shell> [args...]
 *
 * The agent starts this helper through systemd-run, so it already runs with the final
 * identity, slice and sandbox. It allocates one pseudo terminal, runs the shell on it and
 * relays bytes; it never changes identity and never interprets the shell's input.
 *
 * stdin carries frames: [type:u8][length:u16 big-endian][payload].
 *   type 0: terminal input (1..4096 bytes)
 *   type 1: resize, payload cols:u16 rows:u16 (big-endian, 1..1000 each)
 * stdout carries the raw terminal output. stdin EOF hangs up the terminal.
 * Exit status: the shell's status, 128+signal when it was killed, 2 on a protocol error.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pty.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define MAX_PAYLOAD 4096
#define MAX_PENDING (64 * 1024)
#define HANGUP_GRACE_MS 2000

static int parse_dimension(const char *text) {
  char *end = NULL;
  errno = 0;
  long value = strtol(text, &end, 10);
  if (errno || !end || *end || value < 1 || value > 1000) return -1;
  return (int)value;
}

static int write_all(int fd, const unsigned char *data, size_t length) {
  while (length > 0) {
    ssize_t written = write(fd, data, length);
    if (written < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    data += written;
    length -= (size_t)written;
  }
  return 0;
}

static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static int exit_status(int status) {
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 1;
}

int main(int argc, char **argv) {
  if (argc < 4) return 2;
  int cols = parse_dimension(argv[1]), rows = parse_dimension(argv[2]);
  if (cols < 0 || rows < 0 || argv[3][0] != '/') return 2;

  struct winsize size = { .ws_row = (unsigned short)rows, .ws_col = (unsigned short)cols };
  int master = -1;
  pid_t child = forkpty(&master, NULL, NULL, &size);
  if (child < 0) return 1;
  if (child == 0) {
    execv(argv[3], &argv[3]);
    _exit(127);
  }

  signal(SIGPIPE, SIG_IGN);
  fcntl(master, F_SETFL, fcntl(master, F_GETFL) | O_NONBLOCK);

  unsigned char frame[3 + MAX_PAYLOAD];
  size_t frame_length = 0;
  unsigned char pending[MAX_PENDING];
  size_t pending_length = 0;
  unsigned char output[16384];
  int input_open = 1, status = 0, reaped = 0, protocol_error = 0;
  long long hangup_at = -1;

  for (;;) {
    if (!reaped && waitpid(child, &status, WNOHANG) == child) reaped = 1;

    struct pollfd fds[2] = {
      { .fd = master, .events = POLLIN | (pending_length ? POLLOUT : 0) },
      // Stop reading input while the shell is not consuming it: the agent feels the backpressure.
      { .fd = input_open && pending_length + sizeof frame <= MAX_PENDING ? STDIN_FILENO : -1, .events = POLLIN },
    };
    int ready = poll(fds, 2, reaped ? 0 : 250);
    if (ready < 0 && errno != EINTR) break;

    if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
      ssize_t got = read(master, output, sizeof output);
      if (got > 0) {
        if (write_all(STDOUT_FILENO, output, (size_t)got) < 0) break;
      } else if (got == 0 || (errno != EAGAIN && errno != EINTR)) {
        break;
      }
    } else if (reaped) {
      break;
    }

    if ((fds[0].revents & POLLOUT) && pending_length) {
      ssize_t written = write(master, pending, pending_length);
      if (written > 0) {
        memmove(pending, pending + written, pending_length - (size_t)written);
        pending_length -= (size_t)written;
      } else if (written < 0 && errno != EAGAIN && errno != EINTR) {
        break;
      }
    }

    if (fds[1].revents & (POLLIN | POLLHUP | POLLERR)) {
      ssize_t got = read(STDIN_FILENO, frame + frame_length, sizeof frame - frame_length);
      if (got <= 0) {
        if (got < 0 && errno == EINTR) continue;
        input_open = 0;
        hangup_at = now_ms();
        kill(-child, SIGHUP);
        continue;
      }
      frame_length += (size_t)got;
      while (frame_length >= 3) {
        size_t payload = ((size_t)frame[1] << 8) | frame[2];
        if (payload == 0 || payload > MAX_PAYLOAD || frame[0] > 1 || (frame[0] == 1 && payload != 4)) { protocol_error = 1; break; }
        if (frame_length < 3 + payload) break;
        if (frame[0] == 0) {
          memcpy(pending + pending_length, frame + 3, payload);
          pending_length += payload;
        } else {
          int next_cols = (frame[3] << 8) | frame[4], next_rows = (frame[5] << 8) | frame[6];
          if (next_cols < 1 || next_cols > 1000 || next_rows < 1 || next_rows > 1000) { protocol_error = 1; break; }
          struct winsize next = { .ws_row = (unsigned short)next_rows, .ws_col = (unsigned short)next_cols };
          ioctl(master, TIOCSWINSZ, &next);
        }
        memmove(frame, frame + 3 + payload, frame_length - 3 - payload);
        frame_length -= 3 + payload;
      }
      if (protocol_error) break;
    }

    if (hangup_at >= 0 && now_ms() - hangup_at > HANGUP_GRACE_MS) {
      kill(-child, SIGKILL);
      break;
    }
  }

  close(master);
  if (!reaped) {
    kill(-child, SIGHUP);
    for (int attempt = 0; attempt < 20 && waitpid(child, &status, WNOHANG) != child; attempt++) usleep(100000);
    if (waitpid(child, &status, WNOHANG) != child) {
      kill(-child, SIGKILL);
      waitpid(child, &status, 0);
    }
  }
  return protocol_error ? 2 : exit_status(status);
}
