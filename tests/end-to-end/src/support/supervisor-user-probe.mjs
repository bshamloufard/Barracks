/**
 * Run as the supervisor's user (`docker exec --user barrack-supervisor`)
 * inside a sandbox: what that user can do beyond its job, which is reading
 * its token and starting things as the agent. It prints one line of JSON;
 * each attempt reports "allowed", the error code it failed with, or what a
 * command it ran printed and how it exited.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const runAsAgentPath = "/opt/barrack/bin/run-as-agent";

function attempt(action) {
  try {
    action();
    return "allowed";
  } catch (error) {
    return error.code ?? String(error);
  }
}

function run(executable, commandArguments) {
  const outcome = spawnSync(executable, commandArguments, { encoding: "utf8" });
  return {
    exitCode: outcome.status ?? outcome.error?.code,
    output: `${outcome.stdout ?? ""}${outcome.stderr ?? ""}`.trim(),
  };
}

function readStatusField(field) {
  const status = readFileSync("/proc/self/status", "utf8");
  return status.match(new RegExp(`^${field}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? "";
}

console.log(
  JSON.stringify({
    user: readStatusField("Uid"),
    capabilities: Object.fromEntries(
      ["CapInh", "CapPrm", "CapEff", "CapAmb", "CapBnd"].map((field) => [
        field,
        readStatusField(field),
      ]),
    ),
    becomeRootWithSetpriv: run("/usr/bin/setpriv", [
      "--reuid=0",
      "--regid=0",
      "--clear-groups",
      "/usr/bin/id",
      "-u",
    ]),
    helperMakes: run(runAsAgentPath, ["/usr/bin/id"]).output,
    helperGivenAUser: run(runAsAgentPath, ["--reuid=0", "/usr/bin/id", "-u"]),
    helperGivenARelativeProgram: run(runAsAgentPath, ["id"]).exitCode,
    readToken: attempt(() =>
      readFileSync("/var/lib/barrack/secrets/BARRACK_SUPERVISOR_TOKEN", "utf8"),
    ),
    readAgentModelKey: attempt(() => readFileSync("/var/lib/barrack/state/pi/agent/auth.json")),
    writeImageSoftware: {
      helperDirectory: attempt(() => writeFileSync("/opt/barrack/bin/planted", "")),
      supervisor: attempt(() => writeFileSync("/opt/barrack/supervisor/dist/main.js", "")),
      startScripts: attempt(() => writeFileSync("/usr/local/bin/barrack-run-supervisor", "")),
    },
  }),
);
