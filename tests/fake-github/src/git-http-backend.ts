import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Serves Git's smart HTTP protocol from bare repositories under a root
 * directory, through `git http-backend`, Git's own CGI program.
 * https://git-scm.com/docs/git-http-backend
 *
 * Whoever calls this has already decided the request may go ahead; the
 * CGI program is told who the user is so that it accepts pushes.
 */
export function serveGitRequest(
  request: IncomingMessage,
  response: ServerResponse,
  projectRoot: string,
  url: URL,
  remoteUser: string | undefined,
): void {
  const { PATH: searchPath } = process.env;
  const backend = spawn("git", ["http-backend"], {
    env: {
      PATH: searchPath,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.replace(/^\?/, ""),
      REQUEST_METHOD: request.method ?? "GET",
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      ...(request.headers["content-encoding"] === undefined
        ? {}
        : { HTTP_CONTENT_ENCODING: String(request.headers["content-encoding"]) }),
      ...(request.headers["git-protocol"] === undefined
        ? {}
        : { GIT_PROTOCOL: String(request.headers["git-protocol"]) }),
      ...(remoteUser === undefined ? {} : { REMOTE_USER: remoteUser }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  request.pipe(backend.stdin);
  let headerText = "";
  let isHeaderDone = false;
  backend.stdout.on("data", (chunk: Buffer) => {
    if (isHeaderDone) {
      response.write(chunk);
      return;
    }
    headerText += chunk.toString("latin1");
    const headerEnd = headerText.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }
    isHeaderDone = true;
    writeCgiHeaders(response, headerText.slice(0, headerEnd));
    response.write(Buffer.from(headerText.slice(headerEnd + 4), "latin1"));
  });
  backend.stdout.on("end", () => response.end());
  backend.on("error", () => {
    response.statusCode = 500;
    response.end();
  });
}

function writeCgiHeaders(response: ServerResponse, headerBlock: string): void {
  for (const line of headerBlock.split("\r\n")) {
    const separator = line.indexOf(":");
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name.toLowerCase() === "status") {
      response.statusCode = Number(value.split(" ")[0]);
    } else if (name !== "") {
      response.setHeader(name, value);
    }
  }
}
