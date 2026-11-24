/**
 * Run by the agent itself, through its own shell tool, inside a sandbox: it
 * tries every route to the supervisor's secrets, and to the supervisor's
 * privileges, that the sandbox image means to close, and prints what
 * happened as one line of JSON. Each attempt reports "allowed" or the error
 * code it failed with.
 *
 * Arguments: the control plane's port, then the supervisor's token in two
 * halves, so that the token itself never appears in any process's command
 * line, where the probe would find its own copy.
 */
import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const [controlPlanePort, tokenStart, tokenEnd] = process.argv.slice(2);
const token = `${tokenStart}${tokenEnd}`;
const runAsAgentPath = "/opt/barrack/bin/run-as-agent";
const supervisorEntryPoint = "/opt/barrack/supervisor/dist/main.js";
const secretsDirectory = "/var/lib/barrack/secrets";
/** Directories a process can see but that are not files anyone wrote. */
const virtualFileSystems = new Set(["/proc", "/sys", "/dev"]);
/**
 * The image's own software, which nobody in the sandbox can write (the
 * writable-paths search below checks that), and too large to read whole.
 */
const imageSoftware = new Set(["/usr"]);
/** Where the agent may write by design: its own places, and the shared temporary ones. */
const agentPlaces = [
  "/workspace",
  "/var/lib/barrack/state",
  "/home/barrack-agent",
  "/tmp",
  "/var/tmp",
  "/run/lock",
  "/dev/shm",
];

function attempt(action) {
  try {
    action();
    return "allowed";
  } catch (error) {
    return error.code ?? String(error);
  }
}

function readStatusField(processId, field) {
  const status = readFileSync(`/proc/${processId}/status`, "utf8");
  return status.match(new RegExp(`^${field}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? "";
}

function listProcesses() {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .flatMap((name) => {
      try {
        return [
          {
            processId: Number(name),
            userId: Number(readStatusField(name, "Uid").split(/\s+/)[0]),
            parentProcessId: Number(readStatusField(name, "PPid")),
            commandLine: readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " ").trim(),
          },
        ];
      } catch {
        return [];
      }
    });
}

function readOneByte(file) {
  const descriptor = openSync(file, "r");
  try {
    readSync(descriptor, Buffer.alloc(1), 0, 1, 0);
  } finally {
    closeSync(descriptor);
  }
}

function probeOtherProcess(processId) {
  return {
    userId: Number(readStatusField(processId, "Uid").split(/\s+/)[0]),
    readEnvironment: attempt(() => readFileSync(`/proc/${processId}/environ`)),
    listFileDescriptors: attempt(() => readdirSync(`/proc/${processId}/fd`)),
    readMemory: attempt(() => readOneByte(`/proc/${processId}/mem`)),
    signal: attempt(() => process.kill(processId, 0)),
  };
}

function* walkFiles(directory, skipped = virtualFileSystems) {
  for (const entry of walkEntries(directory, skipped)) {
    if (entry.isFile()) {
      yield entry.path;
    }
  }
}

/** Every entry below `directory`, directories included, leaving out `skipped` and what is in them. */
function* walkEntries(directory, skipped = virtualFileSystems) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (skipped.has(entryPath)) {
      continue;
    }
    yield { path: entryPath, isFile: () => entry.isFile(), isDirectory: () => entry.isDirectory() };
    if (entry.isDirectory()) {
      yield* walkEntries(entryPath, skipped);
    }
  }
}

function findSetuidAndSetgidFiles() {
  const found = [];
  for (const file of walkFiles("/")) {
    try {
      if ((lstatSync(file).mode & 0o6000) !== 0) {
        found.push(file);
      }
    } catch {
      // Gone, or not ours to stat: neither can be run.
    }
  }
  return found;
}

/**
 * Every readable place a token could have been written: every process's
 * environment and command line (including processes `docker exec` started,
 * as either user), and every file outside the image's own software and
 * /proc, /sys and /dev, shared memory included.
 */
function findToken(processes) {
  const places = processes.flatMap(({ processId }) => [
    `/proc/${processId}/environ`,
    `/proc/${processId}/cmdline`,
  ]);
  places.push(...walkFiles("/", new Set([...virtualFileSystems, ...imageSoftware])));
  places.push(...walkFiles("/dev/shm"));
  let readCount = 0;
  let containerEnvironmentsRead = 0;
  const foundIn = [];
  for (const place of places) {
    try {
      if (!place.startsWith("/proc/") && statSync(place).size > 4 * 1024 * 1024) {
        continue;
      }
      const contents = readFileSync(place, "latin1");
      readCount += 1;
      if (
        place.endsWith("/environ") &&
        contents.includes("BARRACK_SUPERVISOR_SECRETS_DIRECTORY=")
      ) {
        containerEnvironmentsRead += 1;
      }
      if (contents.includes(token)) {
        foundIn.push(place);
      }
    } catch {
      // Unreadable to the agent, which is the point.
    }
  }
  return { readCount, containerEnvironmentsRead, foundIn };
}

/**
 * Whatever the agent can write outside its own places and the shared
 * temporary ones: anything there that the supervisor ran or read as
 * configuration would be a way into it.
 */
function findWritablePaths() {
  const skipped = new Set([...virtualFileSystems, ...agentPlaces]);
  const writable = [];
  for (const entry of walkEntries("/", skipped)) {
    try {
      if (!lstatSync(entry.path).isSymbolicLink()) {
        accessSync(entry.path, constants.W_OK);
        writable.push(entry.path);
      }
    } catch {
      // Not writable, which is the point.
    }
  }
  return writable;
}

/** The soft and hard limits on a process's core file size, which /proc shows to anyone. */
function readCoreFileLimit(processId) {
  const line = readFileSync(`/proc/${processId}/limits`, "utf8")
    .split("\n")
    .find((limit) => limit.startsWith("Max core file size"));
  const [soft, hard] = line?.split(/\s{2,}/).slice(1, 3) ?? [];
  return { soft, hard };
}

/** Socket inodes of TCP connections to the control plane, from this network namespace's table. */
function findControlPlaneSocketInodes() {
  const portInHex = Number(controlPlanePort).toString(16).toUpperCase().padStart(4, "0");
  return ["/proc/net/tcp", "/proc/net/tcp6"].flatMap((table) =>
    readTextIfPresent(table)
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields[2]?.endsWith(`:${portInHex}`))
      .map((fields) => fields[9]),
  );
}

function readTextIfPresent(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    // /proc/net/tcp6 is absent where IPv6 is off.
    return "";
  }
}

/** What each open file descriptor of a process points at, for the agent's own processes. */
function listFileDescriptors(processId) {
  let descriptors;
  try {
    descriptors = readdirSync(`/proc/${processId}/fd`);
  } catch {
    return [];
  }
  return descriptors.map((descriptor) => {
    try {
      return {
        descriptor: Number(descriptor),
        target: readlinkSync(`/proc/${processId}/fd/${descriptor}`),
      };
    } catch {
      return { descriptor: Number(descriptor), target: "closed" };
    }
  });
}

const ownUserId = process.getuid();
const processes = listProcesses();
/** Every process of another user: the supervisor, tini, and whatever `docker exec` started as the supervisor. */
const otherUsersProcesses = processes.filter(({ userId }) => userId !== ownUserId);
const supervisor = processes.find(({ commandLine }) => commandLine.includes(supervisorEntryPoint));
// Pi renames its process, so it is found as the agent's process that the
// supervisor started.
const pi = processes.find(
  ({ userId, parentProcessId }) =>
    userId === process.getuid() && parentProcessId === supervisor?.processId,
);
const agentProcesses = processes.filter(({ userId }) => userId === ownUserId);
const controlPlaneSocketInodes = findControlPlaneSocketInodes();
const filesHeldByAgent = agentProcesses.flatMap(({ processId }) =>
  listFileDescriptors(processId).map(({ target }) => target),
);
const workspaceFile = "/workspace/written-by-the-agent.txt";
const workspaceWrite = attempt(() => writeFileSync(workspaceFile, "written by the agent\n"));

console.log(
  JSON.stringify({
    identity: {
      user: readStatusField("self", "Uid"),
      group: readStatusField("self", "Gid"),
      groups: readStatusField("self", "Groups"),
      environment: {
        HOME: process.env.HOME,
        USER: process.env.USER,
        LOGNAME: process.env.LOGNAME,
        SHELL: process.env.SHELL,
      },
      workingDirectory: process.cwd(),
    },
    capabilities: Object.fromEntries(
      ["CapInh", "CapPrm", "CapEff", "CapAmb", "NoNewPrivs"].map((field) => [
        field,
        readStatusField("self", field),
      ]),
    ),
    supervisor: supervisor === undefined ? "not found" : probeOtherProcess(supervisor.processId),
    firstProcess: probeOtherProcess(1),
    otherUsersProcesses: otherUsersProcesses.map(({ processId }) => probeOtherProcess(processId)),
    supervisorCoreFileLimit:
      supervisor === undefined ? "not found" : readCoreFileLimit(supervisor.processId),
    runAsAgent: {
      execute: spawnSync(runAsAgentPath, ["--version"]).error?.code ?? "allowed",
      read: attempt(() => readFileSync(runAsAgentPath)),
    },
    supervisorFiles: {
      listRunDirectory: attempt(() => readdirSync("/run/barrack")),
      readLog: attempt(() => readFileSync("/var/log/barrack/supervisor.log")),
      listStateDirectory: attempt(() => readdirSync("/var/lib/barrack/supervisor")),
      listSecretsDirectory: attempt(() => readdirSync(secretsDirectory)),
      readToken: attempt(() => readFileSync(`${secretsDirectory}/BARRACK_SUPERVISOR_TOKEN`)),
      writeDesktopControl: attempt(() => writeFileSync("/run/barrack-desktop/control", "agent")),
      replaceGitHelperSocket: attempt(() =>
        writeFileSync("/run/barrack-git/credential.sock.planted", ""),
      ),
    },
    writablePaths: findWritablePaths(),
    setuidAndSetgidFiles: findSetuidAndSetgidFiles(),
    token: findToken(processes),
    controlPlaneConnection: {
      socketCount: controlPlaneSocketInodes.length,
      heldByAgentProcesses: controlPlaneSocketInodes.some((inode) =>
        filesHeldByAgent.includes(`socket:[${inode}]`),
      ),
    },
    piStandardStreams:
      pi === undefined
        ? "not found"
        : listFileDescriptors(pi.processId)
            .filter(({ descriptor }) => descriptor <= 2)
            .sort((first, second) => first.descriptor - second.descriptor),
    supervisorFilesHeldByAgent: filesHeldByAgent.filter((target) =>
      ["/var/log/barrack", "/run/barrack"].some((directory) => target.startsWith(directory)),
    ),
    workspace: {
      write: workspaceWrite,
      ownerUserId: workspaceWrite === "allowed" ? statSync(workspaceFile).uid : undefined,
    },
  }),
);
