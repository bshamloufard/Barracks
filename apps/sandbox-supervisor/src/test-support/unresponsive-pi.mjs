/**
 * A stand-in for a Pi that has hung, as the supervisor sees one. It answers
 * every command but `abort`, keeps running after its input ends, ignores
 * SIGTERM, and has a command running that ignores SIGTERM too, in a process
 * group of its own, the way Pi starts commands. It writes that command's
 * process ID to the file named by PI_STUB_COMMAND_PROCESS_ID_FILE before it
 * answers anything.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const keepRunning = () => setInterval(() => {}, 60_000);

process.on("SIGTERM", () => {});
const command = spawn(
  process.execPath,
  ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 60_000);'],
  { detached: true, stdio: "ignore" },
);
writeFileSync(process.env.PI_STUB_COMMAND_PROCESS_ID_FILE, String(command.pid));

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "abort") {
    return;
  }
  const response = { type: "response", id: request.id, command: request.type, success: true };
  process.stdout.write(`${JSON.stringify({ ...response, data: {} })}\n`);
});
keepRunning();
