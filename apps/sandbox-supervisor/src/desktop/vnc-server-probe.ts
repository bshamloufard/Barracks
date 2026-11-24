import { connect } from "node:net";

/**
 * Whether a VNC server answers on the loopback port: it speaks first, with
 * its protocol version (`RFB 003.008\n`, RFC 6143 section 7.1.1), so a
 * connection that is accepted but never greets, or greets with something
 * else, does not count. The connection is closed as soon as the greeting
 * has been read.
 */
export function isVncServerAnswering(
  port: number,
  timeoutInMilliseconds = 2_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    const finish = (isAnswering: boolean) => {
      socket.destroy();
      resolve(isAnswering);
    };
    socket.setTimeout(timeoutInMilliseconds, () => finish(false));
    socket.once("data", (greeting) => finish(greeting.toString("latin1").startsWith("RFB ")));
    socket.once("error", () => finish(false));
    socket.once("end", () => finish(false));
  });
}
