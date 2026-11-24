import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestControlPlane } from "../test-support/test-control-plane.js";

const temporaryDirectories: string[] = [];
let controlPlane: TestControlPlane | undefined;

afterEach(async () => {
  await controlPlane?.close();
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

async function get(path: string): Promise<Response> {
  if (controlPlane === undefined) {
    throw new Error("Start the control plane first.");
  }
  return controlPlane.getApi(path);
}

describe("the HTTP app", () => {
  it("reports that it is healthy", async () => {
    controlPlane = await TestControlPlane.start();

    const response = await get("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves no web client when no directory is configured", async () => {
    controlPlane = await TestControlPlane.start();

    const response = await get("/");

    expect(response.status).toBe(404);
  });

  it("serves the built web client's index page when a directory is configured", async () => {
    controlPlane = await TestControlPlane.start({
      webClientDirectory: await webClientDirectoryWithIndexPage(),
    });

    const response = await get("/");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>Barrack</title>");
  });

  it("answers an unknown API route with a JSON error, even when serving the web client", async () => {
    controlPlane = await TestControlPlane.start({
      webClientDirectory: await webClientDirectoryWithIndexPage(),
    });

    const response = await get("/api/nothing-here");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "There is no such API route." },
    });
  });
});
