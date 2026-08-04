import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db";
import { Location } from "../src/location/location";
import { RunnerExecute } from "../src/runner/execute";
import { RunnerExecution } from "../src/runner/execution";
import { Runner } from "../src/runner/run";
import { SandboxController } from "../src/sandbox/control";
import { SandboxDriver } from "../src/sandbox/driver";
import { FakeSandboxDriver } from "../src/sandbox/drivers/fake";
import { SandboxInstance } from "../src/sandbox/instance";
import { SandboxIO } from "../src/sandbox/io";
import { AbsolutePath } from "../src/schema";
import { SessionSchema } from "../src/session/schema";
import { Session } from "../src/session/session";
import { testEffect } from "./utils/effect";

interface Observation {
	readonly sessionId: SessionSchema.ID;
	readonly current: SandboxIO.Identity;
	readonly location: Location.Interface;
	readonly refCount: number;
}

interface Gate {
	readonly started: Deferred.Deferred<void>;
	readonly release: Deferred.Deferred<void>;
}

const fake = FakeSandboxDriver.make(SandboxDriver.Name.make("runner-fake"));
const observations: Observation[] = [];
const gates = new Map<SessionSchema.ID, Gate>();

const runner = Layer.effect(
	Runner.Service,
	Effect.gen(function* () {
		const controller = yield* SandboxController.Controller;
		return Runner.Service.of({
			run: Effect.fnUntraced(function* (input) {
				const current = yield* SandboxIO.Current;
				const location = yield* Location.Service;
				const info = Option.getOrThrow(yield* controller.get(current.id));
				observations.push({
					sessionId: input.sessionId,
					current,
					location,
					refCount: info.refCount,
				});

				const gate = gates.get(input.sessionId);
				if (gate !== undefined) {
					yield* Deferred.succeed(gate.started, undefined);
					yield* Deferred.await(gate.release);
				}
			}),
		});
	}),
);

const database = Database.layer(":memory:");
const infrastructure = Layer.provideMerge(
	SandboxController.layer({ transportIdleTimeToLive: "1 hour" }).pipe(Layer.provide(SandboxDriver.layer(fake.driver))),
	database,
);
const runtime = RunnerExecute.layer.pipe(
	Layer.provide(runner),
	Layer.provideMerge(Session.layer),
	Layer.provideMerge(infrastructure),
);
const { effect: it } = testEffect(runtime);

const reset = () => {
	observations.length = 0;
	gates.clear();
};

const insertProject = Effect.fnUntraced(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('runner', 'runner', 0, 0)`;
});

const createSession = Effect.fnUntraced(function* (input: {
	readonly instanceId?: SandboxInstance.ID;
	readonly directory: string;
}) {
	yield* insertProject();
	const sessions = yield* Session.Service;
	return yield* sessions.create({
		projectId: "runner",
		slug: `runner-${Date.now()}-${Math.random()}`,
		directory: AbsolutePath.make(input.directory),
		title: "runner sandbox",
		sandboxInstanceId: input.instanceId,
	});
});

const createInstance = Effect.fnUntraced(function* () {
	const controller = yield* SandboxController.Controller;
	return yield* controller.create({
		driver: fake.driver,
		config: { defaultCwd: SandboxDriver.AbsolutePath.make("/") },
	});
});

const mkdir = (id: SandboxInstance.ID, directory: string) =>
	Effect.flatMap(SandboxIO.FileSystem, (fs) => fs.mkdir(directory, { recursive: true })).pipe(
		Effect.provide(Layer.unwrap(Effect.map(SandboxController.Controller, (controller) => controller.mount(id)))),
		Effect.scoped,
	);

const makeGate = Effect.gen(function* () {
	return {
		started: yield* Deferred.make<void>(),
		release: yield* Deferred.make<void>(),
	} satisfies Gate;
});

const failure = <E>(exit: Exit.Exit<unknown, E>): E => {
	if (Exit.isSuccess(exit)) throw new Error("expected failure");
	return Cause.squash(exit.cause) as E;
};

describe("RunnerExecution session sandbox mounts", () => {
	it(
		"mounts once, provides Location from the mount, and unmounts on completion",
		Effect.gen(function* () {
			reset();
			const controller = yield* SandboxController.Controller;
			const execution = yield* RunnerExecution.Service;
			const before = fake.state.calls.attach.length;
			const instance = yield* createInstance();
			yield* mkdir(instance.id, "/workspace");
			const session = yield* createSession({ instanceId: instance.id, directory: "/workspace" });

			yield* execution.resume(session.id);

			expect(observations).toHaveLength(1);
			expect(observations[0]!.current).toMatchObject({ id: instance.id, cwd: "/workspace" });
			expect(observations[0]!.location.directory).toBe(observations[0]!.current.cwd);
			expect(observations[0]!.location.sandboxInstanceId).toBe(instance.id);
			expect(observations[0]!.refCount).toBe(1);
			expect(fake.state.calls.attach.length - before).toBe(1);
			expect(Option.getOrThrow(yield* controller.get(instance.id)).refCount).toBe(0);
		}),
	);

	it(
		"interrupts the drain and releases its mount exactly once",
		Effect.gen(function* () {
			reset();
			const controller = yield* SandboxController.Controller;
			const execution = yield* RunnerExecution.Service;
			const instance = yield* createInstance();
			yield* mkdir(instance.id, "/blocked");
			const session = yield* createSession({ instanceId: instance.id, directory: "/blocked" });
			const gate = yield* makeGate;
			gates.set(session.id, gate);

			const fiber = yield* Effect.forkChild(execution.resume(session.id));
			yield* Deferred.await(gate.started);
			expect(Option.getOrThrow(yield* controller.get(instance.id)).refCount).toBe(1);

			yield* execution.interrupt(session.id);
			yield* Fiber.join(fiber).pipe(Effect.exit);

			expect(Option.getOrThrow(yield* controller.get(instance.id)).refCount).toBe(0);
			expect(Array.from(yield* execution.active)).toEqual([]);
		}),
	);

	it(
		"shares one transport while two sessions hold different cwd mounts",
		Effect.gen(function* () {
			reset();
			const controller = yield* SandboxController.Controller;
			const execution = yield* RunnerExecution.Service;
			const before = fake.state.calls.attach.length;
			const instance = yield* createInstance();
			yield* mkdir(instance.id, "/alpha");
			yield* mkdir(instance.id, "/beta");
			const first = yield* createSession({ instanceId: instance.id, directory: "/alpha" });
			const second = yield* createSession({ instanceId: instance.id, directory: "/beta" });
			const firstGate = yield* makeGate;
			const secondGate = yield* makeGate;
			gates.set(first.id, firstGate);
			gates.set(second.id, secondGate);

			const firstFiber = yield* Effect.forkChild(execution.resume(first.id));
			const secondFiber = yield* Effect.forkChild(execution.resume(second.id));
			yield* Effect.all([Deferred.await(firstGate.started), Deferred.await(secondGate.started)], {
				concurrency: "unbounded",
			});

			expect(Option.getOrThrow(yield* controller.get(instance.id)).refCount).toBe(2);
			expect(fake.state.calls.attach.length - before).toBe(1);
			expect(observations.map((entry) => entry.current.cwd).sort()).toEqual(["/alpha", "/beta"]);
			expect(observations.every((entry) => entry.location.directory === entry.current.cwd)).toBe(true);

			yield* Effect.all(
				[Deferred.succeed(firstGate.release, undefined), Deferred.succeed(secondGate.release, undefined)],
				{ concurrency: "unbounded" },
			);
			yield* Effect.all([Fiber.join(firstFiber), Fiber.join(secondFiber)], { concurrency: "unbounded" });
			expect(Option.getOrThrow(yield* controller.get(instance.id)).refCount).toBe(0);
		}),
	);

	it(
		"maps a NULL session namespace to the row-free host",
		Effect.gen(function* () {
			reset();
			const execution = yield* RunnerExecution.Service;
			const session = yield* createSession({ directory: process.cwd() });

			yield* execution.resume(session.id);

			expect(observations).toHaveLength(1);
			expect(observations[0]!.current.id).toBe(SandboxInstance.ID.local);
			expect(observations[0]!.current.kind).toBe("local");
			expect(observations[0]!.location.directory).toBe(observations[0]!.current.cwd);
		}),
		15_000,
	);

	it(
		"rejects a missing directory before Project or Location can persist it",
		Effect.gen(function* () {
			reset();
			const controller = yield* SandboxController.Controller;
			const execution = yield* RunnerExecution.Service;
			const sql = yield* SqlClient.SqlClient;
			const instance = yield* createInstance();
			const session = yield* createSession({ instanceId: instance.id, directory: "/missing" });
			const projectsBefore = yield* sql`SELECT * FROM project ORDER BY id`;
			const directoriesBefore = yield* sql`SELECT * FROM project_directory ORDER BY id`;

			const exit = yield* execution.resume(session.id).pipe(Effect.exit);

			expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true);
			expect(failure(exit)).toBeInstanceOf(Runner.SandboxDirectoryNotFoundError);
			expect(observations).toHaveLength(0);
			expect(yield* sql`SELECT * FROM project ORDER BY id`).toEqual(projectsBefore);
			expect(yield* sql`SELECT * FROM project_directory ORDER BY id`).toEqual(directoriesBefore);
			expect(Option.getOrThrow(yield* controller.get(instance.id)).refCount).toBe(0);
		}),
	);

	it(
		"keeps the control plane and transport alive across consecutive drains",
		Effect.gen(function* () {
			reset();
			const controller = yield* SandboxController.Controller;
			const execution = yield* RunnerExecution.Service;
			const before = fake.state.calls.attach.length;
			const instance = yield* createInstance();
			yield* mkdir(instance.id, "/workspace");
			const session = yield* createSession({ instanceId: instance.id, directory: "/workspace" });

			yield* execution.resume(session.id);
			yield* execution.resume(session.id);

			expect(observations).toHaveLength(2);
			expect(fake.state.calls.attach.length - before).toBe(1);
			expect(Option.getOrThrow(yield* controller.get(instance.id)).refCount).toBe(0);
		}),
	);
});
