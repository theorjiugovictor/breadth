import { describe, expect, it } from "vitest";
import { parseRepoInput } from "./github";

describe("parseRepoInput", () => {
  it("accepts the common ways people paste a repo", () => {
    expect(parseRepoInput("pallets/flask")).toEqual({ owner: "pallets", repo: "flask" });
    expect(parseRepoInput("https://github.com/encode/httpx.git")).toEqual({ owner: "encode", repo: "httpx" });
    expect(parseRepoInput("github.com/honojs/hono/")).toEqual({ owner: "honojs", repo: "hono" });
    expect(parseRepoInput("git@github.com:a/b.git")).toEqual({ owner: "a", repo: "b" });
    expect(parseRepoInput("https://github.com/a/b/tree/main/src/app")).toEqual({ owner: "a", repo: "b", ref: "main", subpath: "src/app" });
  });
  it("rejects things that are not repos", () => {
    expect(parseRepoInput("hello")).toBeUndefined();
    expect(parseRepoInput("https://gitlab.com/a/b")).toBeUndefined();
  });
});
