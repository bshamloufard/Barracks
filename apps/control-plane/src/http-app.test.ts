import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApp } from "./http-app.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function webClientDirectoryWithIndexPage(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "barrack-web-client-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Barrack</title>");
  return directory;
}

describe("the HTTP app", () => {
  it("reports that it is healthy", async () => {
    const response = await createHttpApp(undefined).request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves no web client when no directory is configured", async () => {
    const response = await createHttpApp(undefined).request("/");

    expect(response.status).toBe(404);
  });

  it("serves the built web client's index page when a directory is configured", async () => {
    const app = createHttpApp(await webClientDirectoryWithIndexPage());

    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>Barrack</title>");
  });
});
