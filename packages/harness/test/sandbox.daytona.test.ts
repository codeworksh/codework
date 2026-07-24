import { Effect, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { SandboxRegistry } from "../src/sandbox/map";
import { EnvDaytona } from "../src/sandbox/providers/daytona";
import { Sandbox } from "../src/sandbox/sandbox";
import { Shell } from "../src/sandbox/shell";
import { remoteSandboxSpec } from "./fixtures/remote.spec";
import "./utils/env";

const apiKey = process.env.DAYTONA_API_KEY;
const githubPat = process.env.GITHUB_PAT;
const suite = apiKey ? describe : describe.skip;

const PROVISION_TIMEOUT = 180_000;
const SANDBOX_CWD = "/tmp";
const BAKED_ENV = "from-sandbox";

// One real sandbox serves the complete provider contract. Reattaching through
// SandboxMap does not transfer ownership, so only this runtime deletes it.
suite("Sandbox.EnvDaytona (shared sandbox)", () => {
	let runtime!: ManagedRuntime.ManagedRuntime<Sandbox.Provides, EnvDaytona.DaytonaError>;

	beforeAll(() => {
		runtime = ManagedRuntime.make(
			EnvDaytona.services({
				apiKey,
				persist: false,
				cwd: SANDBOX_CWD,
				envVars: { CW_ENV: BAKED_ENV },
			}),
		);
	});
	afterAll(() => runtime.dispose());

	const run = <A, E>(program: Effect.Effect<A, E, Sandbox.Provides>): Promise<A> => runtime.runPromise(program);

	const resolve = <A, E>(envId: string, program: Effect.Effect<A, E, Sandbox.Provides>): Promise<A> =>
		Effect.runPromise(
			program.pipe(
				Effect.scoped,
				Effect.provide(SandboxRegistry.SandboxMap.get(envId)),
				Effect.provide(SandboxRegistry.layer({ daytona: { apiKey, cwd: SANDBOX_CWD } })),
			),
		);

	remoteSandboxSpec({
		kind: "daytona",
		cwd: SANDBOX_CWD,
		inheritedEnv: { key: "CW_ENV", value: BAKED_ENV },
		run,
		resolve,
		timeout: PROVISION_TIMEOUT,
		githubPat,
	});

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
});
