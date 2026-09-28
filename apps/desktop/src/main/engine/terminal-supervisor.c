// node-pty creates this session leader. Retain its identity until every job is gone,
// including background jobs reparented when the interactive shell exits.
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#ifdef __APPLE__
#include <libproc.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#else
#include <dirent.h>
#endif

static volatile sig_atomic_t stopping = 0;
static void request_stop(int sig) { stopping = sig; }

struct zombie { pid_t pid; unsigned long long born; struct zombie *next; };
static struct zombie *zombies = NULL;
static int observed_zombie(pid_t pid, unsigned long long born) {
  for (struct zombie *seen = zombies; seen; seen = seen->next)
    if (seen->pid == pid && seen->born == born) return 0;
  struct zombie *seen = malloc(sizeof(*seen));
  if (!seen) return -1;
  *seen = (struct zombie){ .pid = pid, .born = born, .next = zombies };
  zombies = seen;
  // One more complete snapshot includes any children forked just before this exit.
  return 2;
}

static int disappeared(pid_t pid) {
#ifdef __APPLE__
  // libproc/getsid hide zombies even though the global PID list retains them. A stable
  // zombie must not keep all terminals open forever; its birth time guards PID reuse.
  struct kinfo_proc info;
  size_t size = sizeof(info);
  int mib[] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, pid };
  if (sysctl(mib, 4, &info, &size, NULL, 0) == 0 && size == sizeof(info) && info.kp_proc.p_stat == SZOMB)
    return observed_zombie(pid, (unsigned long long)info.kp_proc.p_starttime.tv_sec * 1000000 + info.kp_proc.p_starttime.tv_usec);
#endif
  return 2;
}

static int member(pid_t pid, pid_t session) {
  if (pid <= 1 || pid == session) return 0;
  pid_t sid = getsid(pid);
  // A disappearing parent may have forked a child absent from this snapshot. Retry the
  // pass instead of certifying an empty session from incomplete ownership information.
  if (sid < 0) return errno == ESRCH ? disappeared(pid) : -1;
  if (sid != session) return 0;
#ifdef __APPLE__
  struct proc_bsdinfo info;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info))
    return errno == ESRCH ? disappeared(pid) : -1;
  return info.pbi_status == SZOMB ? observed_zombie(pid, info.pbi_start_tvsec * 1000000 + info.pbi_start_tvusec) : 1;
#else
  char file[64], line[4096];
  snprintf(file, sizeof(file), "/proc/%d/stat", pid);
  FILE *stat = fopen(file, "r");
  if (!stat) return errno == ENOENT ? 2 : -1;
  char *result = fgets(line, sizeof(line), stat);
  fclose(stat);
  char *end = result ? strrchr(line, ')') : NULL;
  if (!end) return -1;
  if (end[2] != 'Z') return 1;
  char *save = NULL;
  char *field = strtok_r(end + 2, " ", &save);
  for (int index = 3; field && index < 22; index++) field = strtok_r(NULL, " ", &save);
  return field ? observed_zombie(pid, strtoull(field, NULL, 10)) : -1;
#endif
}

static int stop_member(pid_t pid, pid_t session) {
  int live = member(pid, session);
  if (live <= 0) return live;
  if (live == 2) return 1;
  if (kill(pid, SIGSTOP) < 0 && errno != ESRCH) return -1;
  if (getsid(pid) == session && kill(pid, SIGKILL) < 0 && errno != ESRCH) return -1;
  return 1;
}

static int stop_jobs(pid_t session) {
  int remaining = 0;
#ifdef __APPLE__
  int capacity = proc_listallpids(NULL, 0) + 256;
  if (capacity <= 256) return -1;
  pid_t *pids = NULL;
  int count;
  for (;;) {
    free(pids);
    pids = calloc((size_t)capacity, sizeof(pid_t));
    if (!pids) return -1;
    count = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
    if (count <= 0) { free(pids); return -1; }
    if (count < capacity) break;
    capacity *= 2;
  }
  for (int i = 0; i < count; i++) {
    int result = stop_member(pids[i], session);
    if (result < 0) remaining = -1;
    else if (remaining >= 0) remaining += result;
  }
  free(pids);
#else
  DIR *dir = opendir("/proc");
  if (!dir) return -1;
  struct dirent *entry;
  while ((entry = readdir(dir))) {
    char *end;
    long value = strtol(entry->d_name, &end, 10);
    if (*end || value <= 1) continue;
    int result = stop_member((pid_t)value, session);
    if (result < 0) remaining = -1;
    else if (remaining >= 0) remaining += result;
  }
  closedir(dir);
#endif
  return remaining;
}

int main(int argc, char **argv) {
  if (argc < 3 || getsid(0) != getpid()) {
    fprintf(stderr, "modex: terminal supervisor requires a private PTY session\n");
    return 125;
  }
  signal(SIGHUP, request_stop);
  signal(SIGTERM, request_stop);
  int ignored[] = { SIGINT, SIGQUIT, SIGTSTP, SIGTTIN, SIGTTOU, SIGPIPE };
  for (size_t i = 0; i < sizeof(ignored) / sizeof(ignored[0]); i++) signal(ignored[i], SIG_IGN);
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  if (strlen(argv[1]) >= sizeof(address.sun_path)) return 125;
  strcpy(address.sun_path, argv[1]);
  int control = socket(AF_UNIX, SOCK_STREAM, 0);
  if (control < 0 || connect(control, (struct sockaddr *)&address, sizeof(address)) < 0) {
    perror("modex: terminal control");
    return 125;
  }
  fcntl(control, F_SETFD, FD_CLOEXEC);
  pid_t shell = stopping ? -1 : fork();
  if (shell == 0) {
    close(control);
    // The shell owns foreground input; the supervisor never reads from the terminal.
    if (setpgid(0, 0) < 0 || tcsetpgrp(STDIN_FILENO, getpid()) < 0) {
      perror("modex: foreground shell");
      _exit(125);
    }
    signal(SIGHUP, SIG_DFL);
    signal(SIGTERM, SIG_DFL);
    signal(SIGCHLD, SIG_DFL);
    for (size_t i = 0; i < sizeof(ignored) / sizeof(ignored[0]); i++) signal(ignored[i], SIG_DFL);
    sigset_t empty;
    sigemptyset(&empty);
    sigprocmask(SIG_SETMASK, &empty, NULL);
    execvp(argv[2], argv + 2);
    perror("modex: exec shell");
    _exit(127);
  }
  if (shell < 0 && !stopping) perror("modex: fork shell");
  (void)write(control, "READY\n", 6);
  int status = 125 << 8;
  while (shell > 0 && !stopping) {
    pid_t result = waitpid(shell, &status, WNOHANG);
    if (result == shell) break;
    if (result < 0 && errno != EINTR) break;
    struct pollfd channel = { .fd = control, .events = POLLIN };
    if (poll(&channel, 1, 20) > 0) {
      char command[32];
      ssize_t length = read(control, command, sizeof(command));
      // App death closes the private connection and requests the same cleanup.
      if (length <= 0 || command[0] == 'C') stopping = SIGTERM;
    }
  }
  int exit_code = stopping ? 128 + stopping : WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
  int warned = 0;
  for (;;) {
    while (waitpid(-1, NULL, WNOHANG) > 0) {}
    int remaining = stop_jobs(getpid());
    if (remaining == 0) break;
    if (remaining < 0 && !warned++) fprintf(stderr, "modex: unable to stop a terminal job; waiting before closing\n");
    // On failure keep the session alive. The app can time out and safely retry.
    usleep(20000);
  }
  (void)write(control, "CLEAN\n", 6);
  close(control);
  return exit_code;
}
