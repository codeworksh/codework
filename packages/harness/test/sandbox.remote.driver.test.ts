import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vite-plus/test";
import { Database } from "../src/db/db";
import { SandboxController } from "../src/sandbox/control";
import { SandboxDriver } from "../src/sandbox/driver";
import { DaytonaSandboxDriver } from "../src/sandbox/drivers/daytona";
import { VercelSandboxDriver } from "../src/sandbox/drivers/vercel";
import { SandboxInstance } from "../src/sandbox/instance";
import { SandboxIO } from "../src/sandbox/io";
import { hasLiveOidc } from "./fixtures/vercel";
import "./utils/env";

const apiKey = process.env.DAYTONA_API_KEY;
const oidcToken = process.env.VERCEL_OIDC_TOKEN;
const daytonaSuite = apiKey ? describe : describe.skip;
const vercelSuite = hasLiveOidc(oidcToken) ? describe : describe.skip;

const cleanup = (controller: SandboxController.Controller["Service"], id: SandboxInstance.ID) =>
	Effect.gen(function* () {
		const found = yield* controller.get(id);
		if (Option.isNone(found) || found.value.status === "removed") return;
		const stopped = found.value.status === "offline" ? found.value : yield* controller.stop(id);
		if (stopped.status !== "offline") {
			return yield* Effect.die(`cleanup could not stop sandbox ${id}: ${stopped.status}`);
		}
		yield* controller.destroy(id);
	});

const lifecycle = async <CreateConfig, RuntimeConfig extends SandboxDriver.RuntimeConfigBase>(input: {
	readonly remote: SandboxDriver.Driver<CreateConfig, RuntimeConfig> & SandboxDriver.Registration;
	readonly config: CreateConfig;
	readonly secret: string;
	readonly expectedCancels: boolean;
}) => {
	const dependencies = Layer.merge(Database.layer(":memory:"), SandboxDriver.layer(input.remote));
	const application = SandboxController.layer({ transportIdleTimeToLive: "1 hour" }).pipe(
		Layer.provideMerge(dependencies),
		Layer.orDie,
	);
	const runtime = ManagedRuntime.make(application);

	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const controller = yield* SandboxController.Controller;
				const sql = yield* SqlClient.SqlClient;
				const created = yield* controller.create({
					driver: input.remote,
					config: input.config,
				});
				const marker = `/tmp/codework-driver-${created.id}.txt`;

				return yield* Effect.gen(function* () {
					const mounted = yield* Effect.gen(function* () {
						const current = yield* SandboxIO.Current;
						const fs = yield* SandboxIO.FileSystem;
						const shell = yield* SandboxIO.Shell;
						yield* fs.writeFile(marker, "same namespace");
						return {
							current,
							content: yield* fs.readFile(marker),
							pwd: (yield* shell.exec("pwd")).stdout.trim(),
						};
					}).pipe(Effect.provide(controller.mount(created.id, { cwd: "/tmp" })), Effect.scoped);

					expect(mounted.current.id).toBe(created.id);
					expect(mounted.current.cwd).toBe("/tmp");
					expect(mounted.content).toBe("same namespace");
					expect(mounted.pwd).toBe("/tmp");
					expect(Option.getOrThrow(yield* controller.get(created.id)).usage).toBe("idle");

					const observed = yield* controller.refresh(created.id);
					expect(observed.status).toBe("online");

					const stopped = yield* controller.stop(created.id);
					expect(stopped.status).toBe("offline");
					// Managed Daytona resources disable auto-deletion, so both
					// providers deterministically finish a successful stop here.
					expect(stopped.providerStatus).toEqual(Option.some("stopped"));

					const remounted = yield* Effect.gen(function* () {
						const fs = yield* SandboxIO.FileSystem;
						return yield* fs.readFile(marker);
					}).pipe(Effect.provide(controller.mount(created.id, { cwd: "/tmp" })), Effect.scoped);
					expect(remounted).toBe("same namespace");

					yield* controller.stop(created.id);
					yield* controller.destroy(created.id);
					expect(Option.getOrThrow(yield* controller.get(created.id)).status).toBe("removed");

					const rows = yield* sql<{ runtimeConfig: string }>`
							SELECT runtime_config AS runtimeConfig FROM sandbox_instance WHERE id = ${created.id}
						`;
					expect(rows[0]!.runtimeConfig).not.toContain(input.secret);
					expect(input.remote.registered.capabilities.cancels).toBe(input.expectedCancels);
				}).pipe(Effect.ensuring(cleanup(controller, created.id).pipe(Effect.orDie)));
			}),
		);
	} finally {
		await runtime.dispose();
	}
};

daytonaSuite("Sandbox Daytona lifecycle driver", () => {
	it("runs create, mount, wake, stop, and destroy through the controller", async () => {
		await lifecycle({
			remote: DaytonaSandboxDriver.make({ apiKey }),
			config: {
				language: "typescript",
				autoStopInterval: 5,
				execTimeout: 30,
			},
			secret: apiKey!,
			expectedCancels: false,
		});
	}, 180_000);
});

vercelSuite("Sandbox Vercel lifecycle driver", () => {
	it("runs create, mount, wake, stop, and destroy through the controller", async () => {
		await lifecycle({
			remote: VercelSandboxDriver.make(),
			config: {
				runtime: "node24",
			},
			secret: oidcToken!,
			expectedCancels: true,
		});
	}, 180_000);
});
