import { Effect } from "effect";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { type Interface, Service, defaultLayer, normalize } from "../src/repo/repo.ts";
import { AbsolutePath } from "../src/schema.ts";
import { tmpdir } from "./fixtures/tempdir.ts";

const execFilePromise = promisify(execFile);

const runGit = async (cwd: string, ...args: string[]) => (await execFilePromise("git", args, { cwd })).stdout.trim();

const withRepo = <A>(effect: (repo: Interface) => Effect.Effect<A, unknown>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			return yield* effect(yield* Service);
		}).pipe(Effect.provide(defaultLayer("/"))),
	);

const find = (directory: string) => withRepo((repo) => repo.find(AbsolutePath.make(directory)));

describe("Repo", () => {
	let tmp: { path: string; [Symbol.asyncDispose](): Promise<void> };
	let root: string;

	beforeAll(async () => {
		tmp = await tmpdir();
		root = tmp.path;
	});

	afterAll(async () => {
		await tmp?.[Symbol.asyncDispose]();
	});

	describe("find", () => {
		it("returns undefined for a bare repository", async () => {
			const bare = path.join(root, `bare-${randomUUID()}`);
			// `.git` as a directory holding a bare repo: walk-up finds it, rev-parse has no toplevel.
			await fs.mkdir(bare, { recursive: true });
			await runGit(bare, "init", "--bare", ".git");
			expect(await find(bare)).toBeUndefined();
		});
	});

	describe("normalize", () => {
		it("rejects file urls and empty input", () => {
			expect(normalize("file:///x")).toBeUndefined();
			expect(normalize("")).toBeUndefined();
			expect(normalize("   ")).toBeUndefined();
		});
	});
});
