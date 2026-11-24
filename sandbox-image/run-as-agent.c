/*
 * run-as-agent: runs one program as the sandbox's agent user, and as no one
 * else.
 *
 *     run-as-agent /absolute/path/to/program [argument...]
 *
 * The sandbox supervisor (user barrack-supervisor) starts the coding agent,
 * and every command it runs in the agent's name, through this program. It
 * is installed owned by root and the supervisor's group, mode 0750, with the
 * setuid and setgid file capabilities, so only the supervisor's group can
 * run it and it can change user. It replaced a copy of setpriv, which could
 * change to ANY user, root included, which made the supervisor's user as
 * good as root in the container. This one can become barrack-agent alone,
 * with that user's own group only:
 *
 *   - The target is fixed here, at compile time. No argument, environment
 *     variable or file names a user, group or capability.
 *   - It runs only for the supervisor's user (its real user ID).
 *   - It drops every capability, permitted, effective and inheritable,
 *     clears the ambient set, and sets no_new_privs, so neither the
 *     program nor anything it starts can gain privileges again, through a
 *     setuid or setgid file or file capabilities.
 *   - The program must be named by an absolute path and is executed with
 *     execv, so PATH plays no part. The environment is passed on as given:
 *     the caller chooses the agent's environment, and the supervisor gives
 *     it one built from an allowlist.
 *   - It is linked statically, so no dynamic loader or library path takes
 *     part while it holds its capabilities.
 *
 * Anything else, or any step that fails, ends it with status 126 and a
 * message on standard error, before the program runs. A program that
 * cannot be executed ends it with 127 (missing) or 126.
 *
 * The user and group IDs must match those sandbox-image/Dockerfile creates.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <grp.h>
#include <linux/capability.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#define SUPERVISOR_USER_ID 10001
#define AGENT_USER_ID 10002
#define AGENT_GROUP_ID 10002

#define EXIT_REFUSED 126
#define EXIT_PROGRAM_MISSING 127

static int refuse(const char *reason) {
  fprintf(stderr, "run-as-agent: %s\n", reason);
  return EXIT_REFUSED;
}

static int fail(const char *step) {
  fprintf(stderr, "run-as-agent: %s failed: %s\n", step, strerror(errno));
  return EXIT_REFUSED;
}

/* Empties the permitted, effective and inheritable sets of this process. */
static int drop_every_capability(void) {
  struct __user_cap_header_struct header = {_LINUX_CAPABILITY_VERSION_3, 0};
  struct __user_cap_data_struct none[_LINUX_CAPABILITY_U32S_3];
  memset(none, 0, sizeof none);
  return (int)syscall(SYS_capset, &header, none);
}

int main(int argc, char *argv[]) {
  if (getuid() != SUPERVISOR_USER_ID) {
    return refuse("only the sandbox supervisor's user may run this");
  }
  if (argc < 2 || argv[1][0] != '/') {
    return refuse("usage: run-as-agent /absolute/path/to/program [argument...]");
  }

  /* Groups first: changing them needs CAP_SETGID, kept until the user changes. */
  const gid_t agent_groups[] = {AGENT_GROUP_ID};
  if (setgroups(1, agent_groups) != 0) {
    return fail("setgroups");
  }
  if (setresgid(AGENT_GROUP_ID, AGENT_GROUP_ID, AGENT_GROUP_ID) != 0) {
    return fail("setresgid");
  }
  if (setresuid(AGENT_USER_ID, AGENT_USER_ID, AGENT_USER_ID) != 0) {
    return fail("setresuid");
  }
  /*
   * No user ID was 0, so the kernel kept the capabilities through the
   * change; they are dropped here, before anything of the agent's runs. Once
   * the IDs changed the process stopped being dumpable, so the agent's other
   * processes cannot trace it or read its memory meanwhile.
   */
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0) {
    return fail("clearing the ambient capabilities");
  }
  if (drop_every_capability() != 0) {
    return fail("dropping the capabilities");
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    return fail("setting no_new_privs");
  }
  if (getuid() != AGENT_USER_ID || geteuid() != AGENT_USER_ID || getgid() != AGENT_GROUP_ID ||
      getegid() != AGENT_GROUP_ID) {
    return refuse("the user or group did not change");
  }

  execv(argv[1], &argv[1]);
  int exit_status = errno == ENOENT ? EXIT_PROGRAM_MISSING : EXIT_REFUSED;
  fprintf(stderr, "run-as-agent: cannot run %s: %s\n", argv[1], strerror(errno));
  return exit_status;
}
