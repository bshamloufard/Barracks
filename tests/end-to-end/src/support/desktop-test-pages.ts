import { createServer, type IncomingMessage, type Server } from "node:http";
import { desktopTestPageColours } from "@barrack/mock-model-server";

/**
 * Two web pages for the agent's browser to click through, served from the
 * test's machine, which records what the browser asked of it: the page's
 * own account of what happened in the sandbox, independent of the desktop.
 *
 * - `/start`: a large green link to `/next`.
 * - `/next`: a large blue button that turns the page yellow and reports
 *   the click, and a large magenta text box that reports each click into it
 *   and what is typed in it.
 */
export type DesktopTestPages = {
  /** As the sandbox reaches them, through the Docker host's name. */
  startUrl: string;
  /** Every request's method and path, in order. */
  requests: string[];
  /** What the text box held in its newest report. */
  typedText(): string;
  /** How many clicks the text box has received. */
  textBoxClickCount(): number;
  close(): Promise<void>;
};

/** The text box's colour, which the test finds on the viewer's canvas to click into it. */
export const textBoxColour = [0xcc, 0x33, 0xcc] as const;

const startPage = page(
  "Start",
  `<a id="next" href="/next" style="${block(desktopTestPageColours.firstPageButton)}">Next</a>`,
);

const nextPage = page(
  "Next",
  `<button id="finish" style="${block(desktopTestPageColours.secondPageButton)}">Finish</button>
<input id="typing" autocomplete="off" style="${block(textBoxColour)};font-size:32px;color:#000">
<script>
  const finish = document.getElementById("finish");
  finish.addEventListener("click", () => {
    document.body.style.background = "rgb(${desktopTestPageColours.finishedPage.join(",")})";
    finish.style.display = "none";
    fetch("/clicked", { method: "POST" });
  });
  const typing = document.getElementById("typing");
  typing.addEventListener("click", () => fetch("/text-box-clicked", { method: "POST" }));
  // Numbered, since one report can overtake another on its way.
  let reportNumber = 0;
  typing.addEventListener("input", () => {
    reportNumber += 1;
    const headers = { "x-report-number": String(reportNumber) };
    fetch("/typed", { method: "POST", headers, body: typing.value });
  });
</script>`,
);

function block(rgb: readonly number[]): string {
  return `display:block;width:420px;height:150px;margin:24px;border:0;background:rgb(${rgb.join(",")})`;
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body style="margin:0;background:#fff">${body}</body></html>`;
}

export async function startDesktopTestPages(host: string): Promise<DesktopTestPages> {
  const requests: string[] = [];
  let typedText = "";
  let newestTypedReport = 0;
  let textBoxClickCount = 0;
  const server: Server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === "POST") {
      void readBody(request).then((body) => {
        if (request.url === "/text-box-clicked") {
          textBoxClickCount += 1;
        }
        if (request.url === "/typed") {
          const reportNumber = Number(request.headers["x-report-number"]);
          if (reportNumber > newestTypedReport) {
            newestTypedReport = reportNumber;
            typedText = body;
          }
        }
        response.writeHead(204).end();
      });
      return;
    }
    const html =
      request.url === "/start" ? startPage : request.url === "/next" ? nextPage : undefined;
    if (html === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The test pages are not listening on a port.");
  }
  return {
    startUrl: `http://host.docker.internal:${address.port}/start`,
    requests,
    typedText: () => typedText,
    textBoxClickCount: () => textBoxClickCount,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body;
}
