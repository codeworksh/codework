import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Service, defaultLayer } from "../src/git";
import { AbsolutePath } from "../src/schema";
import { tmpdir } from "./fixtures/tempdir";

const execFilePromise = promisify(execFile);

describe("Git", () => {
  it("discovers a repository and collects command output", async () => {
    await using tmp = await tmpdir();
    const nested = path.join(tmp.path, "packages", "app");

    await fs.mkdir(nested, { recursive: true });
    await execFilePromise("git", ["init", "-b", "main"], { cwd: tmp.path });
    await execFilePromise(
      "git",
      ["remote", "add", "origin", "https://example.com/repo.git"],
      {
        cwd: tmp.path,
      },
    );
    const realRoot = await fs.realpath(tmp.path);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* Service;
        const repo = yield* git.find(AbsolutePath.make(nested));

        return {
          repo,
          branch: yield* git.branch(tmp.path),
          origin: yield* git.origin(tmp.path),
        };
      }).pipe(Effect.provide(defaultLayer("/"))),
    );

    expect(result.repo).toEqual({
      directory: realRoot,
      store: path.join(realRoot, ".git"),
    });
    expect(result.branch).toBe("main");
    expect(result.origin).toBe("https://example.com/repo.git");
  });
});
