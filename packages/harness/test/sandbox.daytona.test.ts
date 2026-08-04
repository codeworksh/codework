import { Daytona } from "@daytona/sdk";
import { Effect, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { SandboxInstance } from "../src/sandbox/instance";
import { SandboxIO } from "../src/sandbox/io";
import { EnvDaytona } from "../src/sandbox/providers/daytona";
import { SandboxResource } from "../src/sandbox/resource";
import { Sandbox } from "../src/sandbox/sandbox";
import { Shell } from "../src/sandbox/shell/shell";
import { cancellationSpec } from "./fixtures/cancellation.spec";
import { remoteSandboxSpec } from "./fixtures/remote.spec";
import { labels, makeRemoteOwner } from "./fixtures/remote-owner";
import "./utils/env";

const apiKey = process.env.DAYTONA_API_KEY;
const githubPat = process.env.GITHUB_PAT;
const suite = apiKey ? describe : describe.skip;

const PROVISION_TIMEOUT = 180_000;
const SANDBOX_CWD = "/tmp";
const BAKED_ENV = "from-sandbox";

// One real sandbox serves the complete provider contract. Reattaching by the
// provider's own locator does not transfer ownership; cleanup is explicit.
suite("Sandbox.EnvDaytona (shared sandbox)", () => {
	let runtime!: ManagedRuntime.ManagedRuntime<Sandbox.Provides | SandboxResource.Service, EnvDaytona.DaytonaError>;
	const owner = makeRemoteOwner("sandbox.daytona");

	beforeAll(async () => {
		const instanceId = SandboxInstance.ID.create();
		const sdk = new Daytona({ apiKey });
		const sandbox = await sdk.create({
			language: "typescript",
			envVars: { CW_ENV: BAKED_ENV },
			autoDeleteInterval: -1,
			labels: labels(instanceId),
		});
		owner.capture(sandbox.id);
		runtime = ManagedRuntime.make(
			EnvDaytona.services({
				apiKey,
				sandboxId: sandbox.id,
				instanceId,
				cwd: SANDBOX_CWD,
			}),
		);
	}, PROVISION_TIMEOUT);
	afterAll(
		() =>
			owner.cleanup({
				destroy: async (id) => {
					const sdk = new Daytona({ apiKey });
					await sdk.delete(await sdk.get(id));
				},
				dispose: () => runtime.dispose(),
			}),
		PROVISION_TIMEOUT,
	);

	const run = <A, E>(program: Effect.Effect<A, E, Sandbox.Provides>): Promise<A> => runtime.runPromise(program);

	const resourceId = () => runtime.runPromise(Effect.map(SandboxResource.Service, (r) => r.providerResourceId));

	const reattach = <A, E>(
		input: { readonly providerResourceId: string; readonly instanceId: SandboxInstance.ID },
		program: Effect.Effect<A, E, Sandbox.Provides>,
	): Promise<A> =>
		Effect.runPromise(
			program.pipe(
				Effect.scoped,
				Effect.provide(
					EnvDaytona.services({
						apiKey,
						sandboxId: input.providerResourceId,
						instanceId: input.instanceId,
						cwd: SANDBOX_CWD,
					}),
				),
			),
		);

	remoteSandboxSpec({
		kind: "daytona",
		cwd: SANDBOX_CWD,
		inheritedEnv: { key: "CW_ENV", value: BAKED_ENV },
		run,
		reattach,
		resourceId,
		// `executeCommand` returns a single `result` string; the adapter keeps it as
		// stdout rather than inventing a split. See §16.5 of the Sandbox IO spec.
		combinesOutput: true,
		timeout: PROVISION_TIMEOUT,
		githubPat,
	});

	// `executeCommand(command, cwd?, env?, timeout?)` takes no abort signal — not
	// in the installed 0.187.0 and not in 0.200.1 either, where `AbortSignal`
	// appears only in `FileSystem`. (Daytona's docs show a `{ signal }` options
	// object, hedged with "if supported by your SDK version"; no published TS SDK
	// supports it.) So interrupting the fiber abandons a process that keeps
	// running remotely.
	//
	// The session API (`createSession` → `executeSessionCommand` → `deleteSession`)
	// *can* cancel, but `SessionExecuteRequest` carries no cwd and no env in any
	// SDK version, so routing commands through it would mean rendering per-command
	// env into the command string — putting Git credentials on the remote process
	// command line. That trade is refused; see §16.5 of the Sandbox IO spec.
	//
	// So this stays declared until Daytona adds `signal` to `executeCommand` or
	// cwd/env to sessions, and this suite fails the day either lands.
	cancellationSpec("daytona", () => ({
		run: (program) => run(program),
		witness: `${SANDBOX_CWD}/cancel-progress`,
		cancels: false,
		settleMillis: 5000,
	}));

	it(
		"boots the default snapshot with Node.js available",
		async () => {
			const node = await run(
				Effect.gen(function* () {
					const shell = yield* Shell;
					return yield* shell.execArgv(["node", "--version"]);
				}),
			);

			expect(node.exitCode).toBe(0);
			expect(node.stdout.trim()).toMatch(/^v\d/);
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
						EnvDaytona.services({
							apiKey,
							sandboxId: providerResourceId,
							instanceId: SandboxInstance.ID.create(),
						}),
					),
				),
			);

			expect(result.cwd.startsWith("/")).toBe(true);
			expect(result.cwd).not.toBe(SANDBOX_CWD);
			expect(result.pwd).toBe(result.cwd);
		},
		PROVISION_TIMEOUT,
	);
});
