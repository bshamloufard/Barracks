import { readFileSync } from "node:fs";
import { sandboxProviderVariableNames } from "@barrack/sandbox-providers";
import { describe, expect, it } from "vitest";
import { controlPlaneVariableNames, readConfiguration } from "./configuration.js";
import { forwardedModelCredentialNames } from "./threads/model-credentials.js";
import { forwardedPiSettingNames } from "./threads/pi-settings.js";

/**
 * The deployment guide's table of Railway variables, and the Railway
 * configuration, are written by hand. These tests fail when either names a
 * variable the control plane does not read, or when the table leaves out
 * one it does, so neither can drift from the configuration schemas. The
 * lists they compare against are themselves checked against what
 * `readConfiguration` actually reads, so a schema added without joining
 * those lists fails here too.
 */

const deploymentGuide = readFileSync(
  new URL("../../../docs/deployment.md", import.meta.url),
  "utf8",
);
const railwayConfiguration = readFileSync(
  new URL("../../../.railway/railway.ts", import.meta.url),
  "utf8",
);

/** Railway's own variable, which tells it the port the service listens on. */
const railwayPortVariable = "PORT";

/** What a hosted deployment configures: the control plane, Daytona and Pi. */
const variablesForHostedDeployment = [
  ...controlPlaneVariableNames,
  "BARRACK_SANDBOX_PROVIDER",
  ...sandboxProviderVariableNames.daytona,
  ...forwardedPiSettingNames,
];

const knownVariables = new Set([
  ...variablesForHostedDeployment,
  ...forwardedModelCredentialNames,
  railwayPortVariable,
]);

/**
 * Every variable named in the first column of the table between the
 * guide's markers, or only those of rows whose second column (where it is
 * set) passes `isSetWhere`.
 */
function variablesInGuideTable(isSetWhere: (setWhere: string) => boolean = () => true): string[] {
  const start = deploymentGuide.indexOf("<!-- railway-variables:start -->");
  const end = deploymentGuide.indexOf("<!-- railway-variables:end -->");
  expect(start, "the guide marks where its variable table starts").toBeGreaterThan(-1);
  expect(end, "and where it ends").toBeGreaterThan(start);
  const rows = deploymentGuide.slice(start, end).split("\n").filter(isTableBodyRow);
  return rows
    .filter((row) => isSetWhere((row.split("|")[2] ?? "").trim()))
    .flatMap((row) => {
      const firstCell = row.split("|")[1] ?? "";
      return [...firstCell.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((match) => match[1] ?? "");
    });
}

function isTableBodyRow(line: string): boolean {
  return line.startsWith("|") && !/^\|\s*-/.test(line) && !line.includes("Variable");
}

/** The names of the variables the Railway configuration sets, from its `env` block. */
function variablesInRailwayConfiguration(): string[] {
  const environmentBlock = railwayConfiguration.slice(railwayConfiguration.indexOf("env: {"));
  return [...environmentBlock.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1] ?? "");
}

/**
 * The variables `readConfiguration` looks at in a hosted deployment's
 * environment (Supabase sign-in, Daytona sandboxes), found by watching
 * which it reads.
 */
function variablesReadByHostedConfiguration(): string[] {
  const readNames = new Set<string>();
  const environment = new Proxy<NodeJS.ProcessEnv>(
    { BARRACK_AUTHENTICATION: "supabase", BARRACK_SANDBOX_PROVIDER: "daytona" },
    {
      get(target, name) {
        if (typeof name === "string") {
          readNames.add(name);
        }
        return Reflect.get(target, name);
      },
    },
  );
  readConfiguration(environment);
  return [...readNames].filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name));
}

describe("the lists of variables the guide is checked against", () => {
  it("include every variable the control plane's configuration reads in a hosted deployment", () => {
    const readNames = variablesReadByHostedConfiguration();

    expect(readNames).toContain("BARRACK_SUPABASE_URL");
    expect(readNames).toContain("DAYTONA_API_KEY");
    expect(readNames.filter((name) => !knownVariables.has(name))).toEqual([]);
  });
});

describe("the deployment guide's table of variables", () => {
  it("names only variables the control plane, its Daytona provider or Railway read", () => {
    const unknown = variablesInGuideTable().filter((name) => !knownVariables.has(name));

    expect(unknown).toEqual([]);
  });

  it("names every variable a hosted control plane reads", () => {
    const documented = new Set(variablesInGuideTable());
    const missing = variablesForHostedDeployment.filter((name) => !documented.has(name));

    expect(missing).toEqual([]);
  });

  it("names only variables set in the dashboard that the Railway configuration preserves", () => {
    // The model provider's key is the one the configuration's comment asks
    // the operator to add, since which provider is theirs to choose.
    const setInDashboard = variablesInGuideTable(
      (setWhere) => setWhere.includes("dashboard") && !setWhere.startsWith("one,"),
    );
    const preserved = new Set(
      [...railwayConfiguration.matchAll(/^\s+([A-Z][A-Z0-9_]*): preserve\(\),/gm)].map(
        (match) => match[1] ?? "",
      ),
    );

    expect(setInDashboard).toContain("BARRACK_GITHUB_APP_PRIVATE_KEY");
    expect(setInDashboard.filter((name) => !preserved.has(name))).toEqual([]);
  });

  it("names every variable the Railway configuration sets", () => {
    const documented = new Set(variablesInGuideTable());
    const configured = variablesInRailwayConfiguration();

    expect(configured).toContain("BARRACK_SANDBOX_PROVIDER");
    expect(configured.filter((name) => !documented.has(name))).toEqual([]);
  });
});
