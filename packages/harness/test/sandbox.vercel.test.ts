import type { Stats } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { SandboxFileSystem } from "../src/sandbox/filesystem/filesystem";
import { RemoteFileSystem } from "../src/sandbox/filesystem/remote";
import { EnvVercel, statsFrom } from "../src/sandbox/providers/vercel";
import { Shell } from "../src/sandbox/shell";
import "./utils/env";

const token = process.env.VERCEL_OIDC_TOKEN;
const suite = token ? describe : describe.skip;

const PROVISION_TIMEOUT = 180_000;

// ⚠️ QUOTA / RATE LIMITS — read before adding or hammering these tests.
//
// Every test in the gated suites below provisions a REAL Vercel sandbox (one
// microVM per `runWith` call / per `services({...})` provide). On the Hobby
// (free) plan two distinct caps apply, and both surface as HTTP 429 from
// `Sandbox.create`:
//
//   1. Concurrency:  max 10 sandboxes running at once.
//        → `{ code: "rate_limit_exceeded", message: "Concurrency limit exceeded (10)" }`
//   2. Creation rate: ~40 sandbox creations per rolling ~10-minute window
//        (`api-sandboxes-vcpus-creation-hobby`).
//        → `{ code: "rate_limited", message: "Too many requests - try again in 10 minutes (more than 40)" }`
//
// A single clean run of this file provisions ~6 sandboxes (well under both
// caps), so it passes on a fresh quota window. But running the file repeatedly
// in quick succession — or alongside other sandbox activity on the same team —
// exhausts the budget and the run fails with 429s that are NOT test/code bugs.
// If you see those: wait for the ~10-minute window to reset, run fewer at a
// time, or upgrade the plan (https://vercel.com/docs/vercel-sandbox/pricing).
//
// `runWith` provisions with `persist: false` so teardown deletes the sandbox
// (no lingering snapshot) and frees the concurrency slot promptly. Leftovers
// can be swept with `Sandbox.list()` + `sandbox.delete()` if a run is killed
// mid-flight.

// Provision a sandbox with the given provider options, run the program against
// its filesystem + shell, and tear the sandbox down. Each call is one microVM.
// `persist: false` keeps these tests from leaving persistent sandboxes/snapshots
// behind, so teardown frees the account's concurrency slot promptly.
const runWith = <A, E>(
	options: EnvVercel.Options,
	program: Effect.Effect<A, E, SandboxFileSystem.Service | Shell>,
): Promise<A> => Effect.runPromise(program.pipe(Effect.provide(EnvVercel.services({ persist: false, ...options }))));

suite("Sandbox.EnvVercel", () => {
	it(
		"SandboxFileSystem.Service and Shell share the remote Vercel sandbox",
		async () => {
			const dir = `cw-${Date.now()}-remote`;
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* SandboxFileSystem.Service;
					const shell = yield* Shell;

					yield* Effect.promise(() => filesystem.writeFile(`${dir}/from-service.txt`, "from service"));
					const cat = yield* shell.exec(`cat ${dir}/from-service.txt`);

					const wrote = yield* shell.exec(`echo "from shell" > ${dir}/from-shell.txt`);
					const back = yield* Effect.promise(() => filesystem.readFile(`${dir}/from-shell.txt`));

					const uname = yield* shell.exec("uname -s");
					const node = yield* shell.exec("node --version");

					yield* Effect.promise(() => filesystem.writeFile(`${dir}/workspace/package.json`, "{}"));
					yield* Effect.promise(() => filesystem.writeFile(`${dir}/workspace/.git/config`, ""));
					yield* Effect.promise(() => filesystem.writeFile(`${dir}/workspace/project/package.json`, "{}"));
					const workspace = yield* Effect.promise(() => filesystem.readdir(`${dir}/workspace`));
					const project = yield* Effect.promise(() => filesystem.readdir(`${dir}/workspace/project`));
					yield* Effect.promise(() => filesystem.writeFile(`${dir}/target.txt`, "target"));
					const linked = yield* shell.exec(`ln -s "$(pwd)/${dir}/target.txt" ${dir}/link.txt`);
					const linkStat = yield* Effect.promise(() => filesystem.stat(`${dir}/link.txt`));
					const linkLstat = yield* Effect.promise(() =>
						(filesystem as RemoteFileSystem.Interface).lstat!(`${dir}/link.txt`),
					);

					return {
						cat,
						wrote,
						back,
						uname,
						node,
						exists: yield* Effect.promise(() => filesystem.exists(`${dir}/from-service.txt`)),
						isDir: yield* Effect.promise(async () => (await filesystem.stat(dir)).isDirectory),
						missing: yield* Effect.promise(() => filesystem.exists(`${dir}/nope.txt`)),
						workspace,
						project,
						linked,
						linkStat,
						linkLstat,
					};
				}).pipe(Effect.provide(EnvVercel.services({ persist: false }))),
			);

			expect(result.cat.exitCode).toBe(0);
			expect(result.cat.stdout.trim()).toBe("from service");
			expect(result.wrote.exitCode).toBe(0);
			expect(result.back.trim()).toBe("from shell");
			expect(result.uname.stdout.trim()).toBe("Linux");
			expect(result.node.exitCode).toBe(0);
			expect(result.node.stdout.trim()).toMatch(/^v\d/);
			expect(result.exists).toBe(true);
			expect(result.isDir).toBe(true);
			expect(result.missing).toBe(false);
			expect(result.workspace).toContain(".git");
			expect(result.workspace).toContain("package.json");
			expect(result.workspace).toContain("project");
			expect(result.project).toContain("package.json");
			expect(result.linked.exitCode).toBe(0);
			expect(result.linkStat.isFile).toBe(true);
			expect(result.linkStat.isSymbolicLink).toBe(false);
			expect(result.linkLstat.isSymbolicLink).toBe(true);
		},
		PROVISION_TIMEOUT,
	);
});

// Provider-specific options must actually take effect inside the sandbox. These
// assert the observable result of each knob rather than trusting the SDK.
suite("Sandbox.EnvVercel custom options", () => {
	it.each([
		["node22", /^v22\./],
		["node24", /^v24\./],
		["node26", /^v26\./],
	] as const)(
		"runtime %s boots the matching node version",
		async (runtime, expected) => {
			const node = await runWith(
				{ runtime },
				Effect.gen(function* () {
					const shell = yield* Shell;
					return yield* shell.exec("node --version");
				}),
			);
			expect(node.exitCode).toBe(0);
			expect(node.stdout.trim()).toMatch(expected);
		},
		PROVISION_TIMEOUT,
	);

	it(
		"envVars are inherited by commands and per-command env overrides them",
		async () => {
			const result = await runWith(
				{ envVars: { CW_ENV: "from-sandbox" } },
				Effect.gen(function* () {
					const shell = yield* Shell;
					const inherited = yield* shell.exec("printenv CW_ENV");
					const overridden = yield* shell.exec("printenv CW_ENV", { env: { CW_ENV: "from-command" } });
					return { inherited, overridden };
				}),
			);
			expect(result.inherited.exitCode).toBe(0);
			expect(result.inherited.stdout.trim()).toBe("from-sandbox");
			expect(result.overridden.stdout.trim()).toBe("from-command");
		},
		PROVISION_TIMEOUT,
	);

	it(
		"cwd threads into both the shell and relative filesystem ops",
		async () => {
			const marker = `cwd-${Date.now()}.txt`;
			const result = await runWith(
				{ cwd: "/tmp" },
				Effect.gen(function* () {
					const filesystem = yield* SandboxFileSystem.Service;
					const shell = yield* Shell;
					const pwd = yield* shell.exec("pwd");
					// relative write resolves against cwd → /tmp/<marker>
					yield* Effect.promise(() => filesystem.writeFile(marker, "in cwd"));
					// the shell runs in cwd too, so the same relative path reads it back
					const cat = yield* shell.exec(`cat ${marker}`);
					const abs = yield* Effect.promise(() => filesystem.readFile(`/tmp/${marker}`));
					return { pwd: pwd.stdout.trim(), cat: cat.stdout.trim(), abs: abs.trim() };
				}),
			);
			expect(result.pwd).toBe("/tmp");
			expect(result.cat).toBe("in cwd");
			expect(result.abs).toBe("in cwd");
		},
		PROVISION_TIMEOUT,
	);
});

// statsFrom maps the SDK's `node:fs` Stats to a FileStat. The contract: isFile,
// isDirectory, and isSymbolicLink are always present; size and mtime are omitted
// (never fabricated) when the stat does not report a finite/valid value.
const stats = (partial: {
	isFile?: boolean;
	isDirectory?: boolean;
	isSymbolicLink?: boolean;
	size?: number;
	mtime?: Date;
}): Stats =>
	({
		isFile: () => partial.isFile ?? false,
		isDirectory: () => partial.isDirectory ?? false,
		isSymbolicLink: () => partial.isSymbolicLink ?? false,
		size: partial.size ?? 0,
		mtime: partial.mtime ?? new Date(0),
	}) as Stats;

describe("Vercel statsFrom", () => {
	it("maps a regular file", () => {
		const stat = statsFrom(stats({ isFile: true, size: 42, mtime: new Date("2026-01-02T03:04:05Z") }));
		expect(stat.isFile).toBe(true);
		expect(stat.isDirectory).toBe(false);
		expect(stat.isSymbolicLink).toBe(false);
		expect(stat.size).toBe(42);
		expect(stat.mtime).toEqual(new Date("2026-01-02T03:04:05Z"));
	});

	it("maps a directory", () => {
		const stat = statsFrom(stats({ isDirectory: true }));
		expect(stat.isDirectory).toBe(true);
		expect(stat.isFile).toBe(false);
	});

	it("detects symlinks", () => {
		const stat = statsFrom(stats({ isSymbolicLink: true }));
		expect(stat.isSymbolicLink).toBe(true);
		expect(stat.isFile).toBe(false);
	});

	it("omits size and mtime the stat did not report, never fabricating them", () => {
		const stat = statsFrom(stats({ isFile: true, size: Number.NaN, mtime: new Date(Number.NaN) }));
		expect(stat.isFile).toBe(true);
		expect(stat.isDirectory).toBe(false);
		expect("size" in stat).toBe(false);
		expect("mtime" in stat).toBe(false);
	});
});
