import { describe, expect, it } from "vitest";
import { parseRepositoryUrl, readGithubFullName } from "./repository-url.js";

const httpsOnly = { allowPlainHttp: false };

describe("repository URLs", () => {
  it("accepts an HTTPS URL, keeping only its scheme, host, port and path", () => {
    expect(parseRepositoryUrl("https://github.com/octo/app.git/", httpsOnly)).toEqual({
      ok: true,
      value: {
        url: "https://github.com/octo/app.git",
        protocol: "https:",
        host: "github.com",
        pathSegments: ["octo", "app.git"],
      },
    });
    expect(parseRepositoryUrl("https://git.example.com:8443/team/tools/app", httpsOnly).ok).toBe(
      true,
    );
  });

  it.each([
    ["plain HTTP", "http://github.com/octo/app"],
    ["SSH", "ssh://git@github.com/octo/app.git"],
    ["SCP-like SSH", "git@github.com:octo/app.git"],
    ["Git's own protocol", "git://github.com/octo/app.git"],
    ["a local file", "file:///etc/passwd"],
    ["a local path", "/srv/repositories/app.git"],
    ["Git's external helpers", "ext::sh -c touch% /tmp/pwned"],
    ["a credential in the URL", "https://x-access-token:secret@github.com/octo/app"],
    ["a user name in the URL", "https://someone@github.com/octo/app"],
    ["a query", "https://github.com/octo/app?ref=main"],
    ["a fragment", "https://github.com/octo/app#readme"],
    ["no path", "https://github.com"],
    ["a parent directory", "https://github.com/octo/../app"],
    ["percent-encoding", "https://github.com/octo/%2e%2e/app"],
    ["an option-like path", "https://github.com/--upload-pack=touch/app"],
  ])("refuses %s", (_description, url) => {
    expect(parseRepositoryUrl(url, httpsOnly).ok).toBe(false);
  });

  it("accepts plain HTTP only where development allows it", () => {
    expect(
      parseRepositoryUrl("http://127.0.0.1:9000/octo/app.git", { allowPlainHttp: true }).ok,
    ).toBe(true);
    expect(parseRepositoryUrl("file:///srv/app.git", { allowPlainHttp: true }).ok).toBe(false);
  });

  it("reads owner and name from a URL on the given GitHub, with or without .git, and nothing else", () => {
    const githubUrl = "https://github.com";
    const read = (url: string) => {
      const parsed = parseRepositoryUrl(url, httpsOnly);
      return parsed.ok ? readGithubFullName(parsed.value, githubUrl) : "invalid";
    };

    expect(read("https://github.com/octo/app")).toBe("octo/app");
    expect(read("https://github.com/octo/app.git")).toBe("octo/app");
    expect(read("https://github.com/octo/app/tree/main")).toBeUndefined();
    expect(read("https://gitlab.com/octo/app")).toBeUndefined();
    expect(read("https://github.com.evil.example/octo/app")).toBeUndefined();
  });
});
