import { Effect } from "effect";
import { SandboxController } from "../sandbox/control.ts";
import { SandboxDriver } from "../sandbox/driver.ts";
import { DaytonaSandboxDriver } from "../sandbox/drivers/daytona.ts";
import { MemorySandboxDriver } from "../sandbox/drivers/memory.ts";
import { SqldbSandboxDriver } from "../sandbox/drivers/sqldb.ts";
import { VercelSandboxDriver } from "../sandbox/drivers/vercel.ts";
import { SandboxInstance } from "../sandbox/instance.ts";

export type Info = SandboxInstance.Info;
export type Driver = SandboxDriver.Registration;

export type CreateInput =
	| { readonly driver: "memory"; readonly cwd?: string }
	| { readonly driver: "sqldb"; readonly cwd?: string; readonly location?: string }
	| ({ readonly driver: "vercel" } & VercelSandboxDriver.CreateConfig)
	| ({ readonly driver: "daytona" } & DaytonaSandboxDriver.CreateConfig);

export type RegisterInput = {
	readonly driver: "vercel" | "daytona";
	readonly providerResourceId: string;
};

const registered = Effect.fn("Sandbox.registered")(function* (name: string) {
	const registry = yield* SandboxDriver.Registry;
	return yield* registry.get(SandboxDriver.Name.make(name));
});

export const create = Effect.fn("Sandbox.create")(function* (input: CreateInput) {
	const controller = yield* SandboxController.Controller;
	const driver = yield* registered(input.driver);
	if (input.driver === "memory") {
		const cwd = SandboxDriver.AbsolutePath.make(input.cwd ?? "/");
		return yield* controller.create({ driver, config: { defaultCwd: cwd, initializeCwd: cwd } });
	}
	if (input.driver === "sqldb") {
		const cwd = SandboxDriver.AbsolutePath.make(input.cwd ?? "/");
		return yield* controller.create({
			driver,
			config: {
				defaultCwd: cwd,
				initializeCwd: cwd,
				...(input.location === undefined ? {} : { location: input.location }),
			},
		});
	}
	const { driver: _, ...config } = input;
	return yield* controller.create({ driver, config });
});

export const register = Effect.fn("Sandbox.register")(function* (input: RegisterInput) {
	const controller = yield* SandboxController.Controller;
	const driver = yield* registered(input.driver);
	return yield* controller.register({ driver, providerResourceId: input.providerResourceId });
});

export const get = Effect.fn("Sandbox.get")(function* (id: SandboxInstance.ID) {
	const controller = yield* SandboxController.Controller;
	return yield* controller.get(id);
});

export const list = Effect.fn("Sandbox.list")(function* (input?: {
	readonly driver?: string;
	readonly status?: SandboxInstance.Status;
}) {
	const controller = yield* SandboxController.Controller;
	return yield* controller.list({
		...(input?.driver === undefined ? {} : { driver: SandboxDriver.Name.make(input.driver) }),
		...(input?.status === undefined ? {} : { status: input.status }),
	});
});

export const refresh = Effect.fn("Sandbox.refresh")(function* (id: SandboxInstance.ID) {
	const controller = yield* SandboxController.Controller;
	return yield* controller.refresh(id);
});

export const wake = Effect.fn("Sandbox.wake")(function* (id: SandboxInstance.ID) {
	const controller = yield* SandboxController.Controller;
	return yield* controller.wake(id);
});

export const stop = Effect.fn("Sandbox.stop")(function* (id: SandboxInstance.ID) {
	const controller = yield* SandboxController.Controller;
	return yield* controller.stop(id);
});

export const destroy = Effect.fn("Sandbox.destroy")(function* (id: SandboxInstance.ID) {
	const controller = yield* SandboxController.Controller;
	yield* controller.destroy(id);
});

export const Drivers = {
	get memory(): Driver {
		return MemorySandboxDriver.make().driver;
	},
	get sqldb(): Driver {
		return SqldbSandboxDriver.make().driver;
	},
	vercel: (options: VercelSandboxDriver.ClientOptions = {}): Driver => VercelSandboxDriver.make(options),
	daytona: (options: DaytonaSandboxDriver.ClientOptions = {}): Driver => DaytonaSandboxDriver.make(options),
} as const;

export { SandboxInstance };

export * as Sandbox from "./sandbox.ts";
