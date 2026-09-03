import { Sandbox as RemoteSandbox } from "@vercel/sandbox";
import { Effect, ManagedRuntime, Stream } from "effect";
import type { Stats } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { SandboxFileSystem } from "../src/sandbox/fs/filesystem.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { SandboxIO } from "../src/sandbox/io.ts";
import * as EnvVercel from "../src/sandboxes/vercel/provider.ts";
import { statsFrom } from "../src/sandboxes/vercel/provider.ts";
import { SandboxResource } from "../src/sandbox/resource.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { Shell } from "../src/sandbox/shell/shell.ts";
import { cancellationSpec } from "./fixtures/cancellation.spec.ts";
import { labels } from "./fixtures/remote-owner.ts";
import { remoteSandboxSpec } from "./fixtures/remote.spec.ts";
import { runnerCycleSpec } from "./fixtures/runner.cycle.spec.ts";
import { toolsRegistryVercelSpec } from "./fixtures/tools.registry.vercel.spec.ts";
import { hasLiveOidc } from "./fixtures/vercel.ts";
import "./utils/env.ts";

const token = process.env.VERCEL_OIDC_TOKEN;
const githubPat = process.env.GITHUB_PAT;
const suite = hasLiveOidc(token) ? describe : describe.skip;

const PROVISION_TIMEOUT = 180_000;

// ⚠️ ONE shared sandbox for the whole gated suite.
//
// The free plan has strict creation/account quotas; exhausting them can surface
// as HTTP 402/429 from `Sandbox.create`. This is the ONLY Vercel provisioning
// site in the harness tests: it gets or creates one named microVM in `beforeAll`
// and shares its locator with every provider, tool, and runner contract below.
// Teardown stops the microVM but deliberately keeps the named sandbox so the
// next test command resumes it instead of consuming another creation.
//
// Creation-time options that would otherwise each need their own sandbox are
// baked into this one box so their behavior is still covered: a fixed `node24`
// runtime, a `cwd`, and an `envVars` entry. (A per-runtime matrix would need a
// sandbox per version, which is intentionally not done — see git history.)
const SANDBOX_CWD = "/tmp";
const BAKED_ENV = "from-sandbox";
const CONFIGURED_SANDBOX_NAME = process.env.VERCEL_TEST_SANDBOX_NAME?.trim() || undefined;
const DEFAULT_SANDBOX_NAME = "codework-harness-test";

const sharedSandbox = async (instanceId: SandboxInstance.ID): Promise<RemoteSandbox> => {
	if (CONFIGURED_SANDBOX_NAME !== undefined) {
		return RemoteSandbox.getOrCreate({
			name: CONFIGURED_SANDBOX_NAME,
			runtime: "node24",
			env: { CW_ENV: BAKED_ENV },
			tags: { ...labels(instanceId), "codework-suite": "harness" },
			persistent: true,
		});
	}

	const sandboxes = await (await RemoteSandbox.list()).toArray();
	const named = sandboxes.find((sandbox) => sandbox.name === DEFAULT_SANDBOX_NAME);
	if (named !== undefined) return RemoteSandbox.get({ name: named.name });

	const managed = sandboxes.filter(
		(sandbox) =>
			sandbox.runtime === "node24" &&
			sandbox.persistent &&
			sandbox.tags?.["codework-managed"] === "true" &&
			sandbox.tags?.["codework-test"] === "true",
	);
	if (managed.length === 1) return RemoteSandbox.get({ name: managed[0]!.name });
	if (managed.length > 1) {
		throw new Error(
			`multiple reusable Vercel test sandboxes found (${managed.map((sandbox) => sandbox.name).join(", ")}); set VERCEL_TEST_SANDBOX_NAME`,
		);
	}

	return RemoteSandbox.getOrCreate({
		name: DEFAULT_SANDBOX_NAME,
		runtime: "node24",
		env: { CW_ENV: BAKED_ENV },
		tags: { ...labels(instanceId), "codework-suite": "harness" },
		persistent: true,
	});
};

suite("Sandbox.EnvVercel (shared sandbox)", () => {
	let runtime:
		| ManagedRuntime.ManagedRuntime<Sandbox.Provides | SandboxResource.Service, EnvVercel.VercelError>
		| undefined;
	let remote: RemoteSandbox | undefined;

	beforeAll(async () => {
		const instanceId = SandboxInstance.ID.create();
		remote = await sharedSandbox(instanceId);
		runtime = ManagedRuntime.make(
			EnvVercel.services({
				sandboxName: remote.name,
				instanceId,
				cwd: SANDBOX_CWD,
			}),
		);
	}, PROVISION_TIMEOUT);
	afterAll(async () => {
		const failures: unknown[] = [];
		if (runtime !== undefined) {
			try {
				await runtime.dispose();
			} catch (cause) {
				failures.push(cause);
			}
		}
		if (remote !== undefined && remote.status !== "stopped") {
			try {
				await remote.stop();
			} catch (cause) {
				failures.push(cause);
			}
		}

		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, "shared Vercel sandbox cleanup failed");
	}, PROVISION_TIMEOUT);

	const sharedRuntime = () => {
		if (runtime === undefined) throw new Error("shared Vercel sandbox runtime is not initialized");
		return runtime;
	};

	// Run a program against the one shared sandbox.
	const run = <A, E>(program: Effect.Effect<A, E, Sandbox.Provides>): Promise<A> =>
		sharedRuntime().runPromise(program);

	// The locator for the shared sandbox — what the control plane records as
	// `provider_resource_id` and reattaches through.
	const resourceId = () =>
		sharedRuntime().runPromise(Effect.map(SandboxResource.Service, (r) => r.providerResourceId));

	// Every Vercel-backed harness contract below reattaches to this locator.
	// No nested spec is allowed to provision or destroy a provider resource.
	runnerCycleSpec(resourceId);
	toolsRegistryVercelSpec(resourceId);

	// A second, independent mount of the same underlying resource.
	const reattach = <A, E>(
		input: { readonly providerResourceId: string; readonly instanceId: SandboxInstance.ID },
		program: Effect.Effect<A, E, Sandbox.Provides>,
	): Promise<A> =>
		Effect.runPromise(
			program.pipe(
				Effect.scoped,
				Effect.provide(
					EnvVercel.services({
						sandboxName: input.providerResourceId,
						instanceId: input.instanceId,
						cwd: SANDBOX_CWD,
					}),
				),
			),
		);

	remoteSandboxSpec({
		kind: "vercel",
		cwd: SANDBOX_CWD,
		inheritedEnv: { key: "CW_ENV", value: BAKED_ENV },
		run,
		reattach,
		resourceId,
		timeout: PROVISION_TIMEOUT,
		githubPat,
	});

	// Vercel spawns detached commands and registers `kill("SIGKILL")` as a scope
	// finalizer, so an interrupt should terminate the remote process rather than
	// abandon it.
	cancellationSpec("vercel", () => ({
		run: (program) => run(program),
		witness: `${SANDBOX_CWD}/cancel-progress`,
		cancels: true,
		settleMillis: 5000,
	}));

	it(
		"shares one filesystem + shell across SandboxFileSystem.Service and Shell",
		async () => {
			const dir = `cw-${Date.now()}-share`;
			const result = await run(
				Effect.gen(function* () {
					const filesystem = yield* SandboxFileSystem.Service;
					const shell = yield* Shell;
					const envId = (yield* SandboxIO.Current).id;

					yield* filesystem.writeFile(`${dir}/from-service.txt`, "from service");
					const cat = yield* shell.exec(`cat ${dir}/from-service.txt`);

					yield* shell.exec(`echo "from shell" > ${dir}/from-shell.txt`);
					const back = yield* filesystem.readFile(`${dir}/from-shell.txt`);

					yield* filesystem.writeFile(`${dir}/workspace/package.json`, "{}");
					yield* filesystem.writeFile(`${dir}/workspace/.git/config`, "");
					yield* filesystem.writeFile(`${dir}/workspace/project/package.json`, "{}");
					const workspace = yield* filesystem.readdir(`${dir}/workspace`);
					const project = yield* filesystem.readdir(`${dir}/workspace/project`);

					yield* filesystem.writeFile(`${dir}/target.txt`, "target");
					const linked = yield* shell.exec(`ln -s "$(pwd)/${dir}/target.txt" ${dir}/link.txt`);
					const linkStat = yield* filesystem.stat(`${dir}/link.txt`);
					const linkLstat = yield* filesystem.lstat!(`${dir}/link.txt`);

					return {
						cat,
						back,
						uname: yield* shell.exec("uname -s"),
						exists: yield* filesystem.exists(`${dir}/from-service.txt`),
						missing: yield* filesystem.exists(`${dir}/nope.txt`),
						workspace,
						project,
						linked,
						linkStat,
						linkLstat,
						envId,
					};
				}),
			);

			expect(result.cat.exitCode).toBe(0);
			expect(result.cat.stdout.trim()).toBe("from service");
			expect(result.back.trim()).toBe("from shell");
			expect(result.uname.stdout.trim()).toBe("Linux");
			expect(result.exists).toBe(true);
			expect(result.missing).toBe(false);
			expect(result.workspace).toContain(".git");
			expect(result.workspace).toContain("package.json");
			expect(result.workspace).toContain("project");
			expect(result.project).toContain("package.json");
			expect(result.linked.exitCode).toBe(0);
			expect(result.linkStat.isFile).toBe(true);
			expect(result.linkStat.isSymbolicLink).toBe(false);
			expect(result.linkLstat.isSymbolicLink).toBe(true);
			// The id is minted, not derived from the provider locator (§6.1).
			expect(result.envId).toMatch(/^sbx_/);
		},
		PROVISION_TIMEOUT,
	);

	it(
		"boots the configured node runtime (node24)",
		async () => {
			const node = await run(
				Effect.gen(function* () {
					const shell = yield* Shell;
					return yield* shell.exec("node --version");
				}),
			);
			expect(node.exitCode).toBe(0);
			expect(node.stdout.trim()).toMatch(/^v24\./);
		},
		PROVISION_TIMEOUT,
	);

	it(
		"inherits sandbox envVars and lets a per-command env override them",
		async () => {
			const result = await run(
				Effect.gen(function* () {
					const shell = yield* Shell;
					const inherited = yield* shell.exec("printenv CW_ENV");
					const overridden = yield* shell.exec("printenv CW_ENV", { env: { CW_ENV: "from-command" } });
					return { inherited, overridden };
				}),
			);
			expect(result.inherited.stdout.trim()).toBe(BAKED_ENV);
			expect(result.overridden.stdout.trim()).toBe("from-command");
		},
		PROVISION_TIMEOUT,
	);

	it(
		"runs the shell and resolves relative fs ops in the configured cwd",
		async () => {
			const marker = `cwd-${Date.now()}.txt`;
			const result = await run(
				Effect.gen(function* () {
					const filesystem = yield* SandboxFileSystem.Service;
					const shell = yield* Shell;
					const pwd = yield* shell.exec("pwd");
					// relative write resolves against cwd → /tmp/<marker>
					yield* filesystem.writeFile(marker, "in cwd");
					const cat = yield* shell.exec(`cat ${marker}`);
					const abs = yield* filesystem.readFile(`${SANDBOX_CWD}/${marker}`);
					return { pwd: pwd.stdout.trim(), cat: cat.stdout.trim(), abs: abs.trim() };
				}),
			);
			expect(result.pwd).toBe(SANDBOX_CWD);
			expect(result.cat).toBe("in cwd");
			expect(result.abs).toBe("in cwd");
		},
		PROVISION_TIMEOUT,
	);

	it(
		"uses the namespace default when cwd is omitted",
		async () => {
			const providerResourceId = await resourceId();
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const current = yield* SandboxIO.Current;
					const shell = yield* Shell;
					return { cwd: current.cwd, pwd: (yield* shell.exec("pwd")).stdout.trim() };
				}).pipe(
					Effect.scoped,
					Effect.provide(
						EnvVercel.services({
							sandboxName: providerResourceId,
							instanceId: SandboxInstance.ID.create(),
						}),
					),
				),
			);

			expect(result.cwd).toBe(EnvVercel.DEFAULT_CWD);
			expect(result.pwd).toBe(EnvVercel.DEFAULT_CWD);
		},
		PROVISION_TIMEOUT,
	);

	it(
		"reports stderr and a non-zero exit from a buffered exec",
		async () => {
			const result = await run(
				Effect.gen(function* () {
					const shell = yield* Shell;
					return yield* shell.exec("echo oops >&2; exit 5");
				}),
			);
			expect(result.exitCode).toBe(5);
			expect(result.stderr).toContain("oops");
		},
		PROVISION_TIMEOUT,
	);

	it(
		"spawns execArgv as a real argument vector, so nothing is shell-interpreted",
		async () => {
			const result = await run(
				Effect.gen(function* () {
					const shell = yield* Shell;
					// Vercel takes cmd + args natively, so these never reach a parser:
					// a space stays one argument and `$(…)` stays literal text.
					const spaced = yield* shell.execArgv(["echo", "two words"]);
					const substitution = yield* shell.execArgv(["echo", "$(echo pwned)"]);
					const semicolon = yield* shell.execArgv(["echo", "a; echo pwned"]);
					return { spaced, substitution, semicolon };
				}),
			);

			expect(result.spaced.exitCode).toBe(0);
			expect(result.spaced.stdout.trim()).toBe("two words");
			expect(result.substitution.stdout.trim()).toBe("$(echo pwned)");
			expect(result.semicolon.stdout.trim()).toBe("a; echo pwned");
		},
		PROVISION_TIMEOUT,
	);

	it(
		"interrupting a long exec returns control promptly (step 6 cancellation)",
		async () => {
			const elapsedMs = await run(
				Effect.gen(function* () {
					const shell = yield* Shell;
					const started = Date.now();
					// The timeout interrupts the exec fiber; the detached command's kill
					// finalizer fires so the remote process does not linger.
					yield* shell.exec("sleep 30").pipe(Effect.timeout("3 seconds"), Effect.ignore);
					return Date.now() - started;
				}),
			);
			expect(elapsedMs).toBeLessThan(15_000);
		},
		PROVISION_TIMEOUT,
	);

	it(
		"streams stdout/stderr chunks then a terminal exit (step 7)",
		async () => {
			const result = await run(
				Effect.gen(function* () {
					const filesystem = yield* SandboxFileSystem.Service;
					const shell = yield* Shell;
					if (shell.stream === undefined) throw new Error("Vercel Shell should support stream");
					const cwd = `stream-${Date.now()}`;
					yield* filesystem.mkdir(cwd);
					const chunks = yield* shell
						.stream("pwd; printf 'hello\\n'; printf 'oops\\n' >&2; exit 0", { cwd })
						.pipe(
							Stream.runCollect,
							Effect.ensuring(filesystem.rm(cwd, { recursive: true, force: true }).pipe(Effect.ignore)),
						);
					return { chunks, cwd: `${SANDBOX_CWD}/${cwd}` };
				}),
			);

			const decoder = new TextDecoder();
			let text = "";
			let exitCode: number | undefined;
			for (const chunk of result.chunks) {
				if (chunk._tag === "exit") exitCode = chunk.exitCode;
				else text += decoder.decode(chunk.bytes);
			}

			expect(text).toContain(result.cwd);
			expect(text).toContain("hello");
			expect(text).toContain("oops");
			expect(exitCode).toBe(0);
		},
		PROVISION_TIMEOUT,
	);

	it(
		"streams many lines in order over the real backend",
		async () => {
			const chunks = await run(
				Effect.gen(function* () {
					const shell = yield* Shell;
					if (shell.stream === undefined) throw new Error("Vercel Shell should support stream");
					return yield* shell.stream("seq 1 50").pipe(Stream.runCollect);
				}),
			);

			const decoder = new TextDecoder();
			let text = "";
			let exitCode: number | undefined;
			for (const chunk of chunks) {
				if (chunk._tag === "exit") exitCode = chunk.exitCode;
				else text += decoder.decode(chunk.bytes);
			}
			const lines = text.split("\n").filter((line) => line.length > 0);

			expect(lines.length).toBe(50);
			expect(lines[0]).toBe("1");
			expect(lines.at(-1)).toBe("50");
			expect(exitCode).toBe(0);
		},
		PROVISION_TIMEOUT,
	);

	it(
		"surfaces a non-zero exit code from a streamed command",
		async () => {
			const chunks = await run(
				Effect.gen(function* () {
					const shell = yield* Shell;
					if (shell.stream === undefined) throw new Error("Vercel Shell should support stream");
					return yield* shell.stream("echo nope; exit 3").pipe(Stream.runCollect);
				}),
			);

			const exit = chunks.find((chunk) => chunk._tag === "exit");
			expect(exit).toBeDefined();
			expect((exit as { exitCode: number }).exitCode).toBe(3);
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
