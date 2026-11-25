import { readFile } from "node:fs/promises";
import { serveFakeVncDesktop } from "./fake-vnc-desktop.js";

/**
 * The fake desktop as the supervisor runs it: on the port it is given,
 * showing the JPEG named by its one argument, until its standard input
 * closes.
 */
const [jpegPath] = process.argv.slice(2);
const { BARRACK_DESKTOP_VNC_PORT: portText } = process.env;
const port = Number(portText);
if (jpegPath === undefined || !Number.isInteger(port)) {
  throw new Error("Run as a desktop command: with BARRACK_DESKTOP_VNC_PORT and a JPEG's path.");
}
const server = await serveFakeVncDesktop(port, await readFile(jpegPath));
process.stdin.on("end", () => {
  server.close();
  process.exit(0);
});
process.stdin.resume();
