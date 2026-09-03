import { Sandbox as RemoteSandbox } from "@vercel/sandbox";
import { Effect, ManagedRuntime, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { SandboxFileSystem } from "../src/sandbox/fs/filesystem.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { SandboxIO } from "../src/sandbox/io.ts";
import * as EnvVercel from "../src/sandboxes/vercel/provider.ts";
import { SandboxResource } from "../src/sandbox/resource.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { Shell } from "../src/sandbox/shell/shell.ts";
import { cancellationSpec } from "./fixtures/cancellation.spec.ts";
import { labels, makeRemoteOwner } from "./fixtures/remote-owner.ts";
import { remoteSandboxSpec } from "./fixtures/remote.spec.ts";
import { runnerCycleSpec } from "./fixtures/runner.cycle.spec.ts";
import { toolsRegistryVercelSpec } from "./fixtures/tools.registry.vercel.spec.ts";
import { hasLiveOidc } from "./fixtures/vercel.ts";
import "./utils/env.ts";

const token = process.env.VERCEL_OIDC_TOKEN;
const githubPat = process.env.GITHUB_PAT;
const suite = hasLiveOidc(token) ? describe : describe.skip;

const PROVISION_TIMEOUT = 180_000;

// One fresh sandbox serves this complete provider contract and is destroyed by
// the suite owner. Remote E2E files run serially so the free-tier VM limit is
// never consumed by parallel Vercel cases.
const SANDBOX_CWD = "/tmp";
const BAKED_ENV = "from-sandbox";
const SANDBOX_TIMEOUT = 15 * 60 * 1000;

suite("Sandbox.EnvVercel (fresh sandbox)", () => {
	let runtime:
		| ManagedRuntime.ManagedRuntime<Sandbox.Provides | SandboxResource.Service, EnvVercel.VercelError>
		| undefined;
	const owner = makeRemoteOwner("sandbox.vercel");

	beforeAll(async () => {
		const instanceId = SandboxInstance.ID.create();
		const remote = await RemoteSandbox.create({
			runtime: "node24",
			env: { CW_ENV: BAKED_ENV },
			tags: { ...labels(instanceId), "codework-suite": "harness" },
			persistent: true,
			timeout: SANDBOX_TIMEOUT,
		});
		owner.capture(remote.name);
		runtime = ManagedRuntime.make(
			EnvVercel.services({
				sandboxName: remote.name,
				instanceId,
				cwd: SANDBOX_CWD,
			}),
		);
	}, PROVISION_TIMEOUT);
	afterAll(
		() =>
			owner.cleanup({
				destroy: async (name) => {
					const sandbox = await RemoteSandbox.get({ name, resume: false });
					await sandbox.delete();
				},
				dispose: () => (runtime === undefined ? Promise.resolve() : runtime.dispose()),
			}),
		PROVISION_TIMEOUT,
	);

	const sharedRuntime = () => {
		if (runtime === undefined) throw new Error("Vercel sandbox runtime is not initialized");
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
