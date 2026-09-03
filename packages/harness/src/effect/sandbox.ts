import { Effect } from "effect";
import { SandboxController } from "../sandbox/control.ts";
import { SandboxDriver } from "../sandbox/driver.ts";
import { SandboxDriverRegistrationError } from "../sandbox/errors.ts";
import { SandboxInstance } from "../sandbox/instance.ts";
import { SandboxDriverLoader } from "../sandbox/loader.ts";
import { SandboxDriverRegistry, type DriverInfo } from "../sandbox/registry.ts";

export type Info = SandboxInstance.Info;
export type Driver = SandboxDriverLoader.Entry;
export type { DriverInfo };

export interface CreateInput {
	readonly driver: string;
	readonly config?: unknown;
}

export interface RegisterInput {
	readonly driver: string;
	readonly providerResourceId: string;
	readonly runtimeConfig?: unknown;
}

const name = (value: string) => SandboxDriver.Name.make(value);

const registered = Effect.fn("Sandbox.registered")(function* (value: string) {
	const registry = yield* SandboxDriverRegistry.Registry;
	return yield* registry.get(name(value));
});

const runtimeOverrides = (driver: SandboxDriver.Name, value: unknown) => {
	if (value === undefined) return Effect.void;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return Effect.fail(
			new SandboxDriverRegistrationError({
				driver,
				reason: "runtimeConfig must be an object",
			}),
		);
	}
	return Effect.succeed(value as Readonly<Record<string, unknown>>);
};

export const create = Effect.fn("Sandbox.create")(function* (input: CreateInput) {
	const controller = yield* SandboxController.Controller;
	const registry = yield* SandboxDriverRegistry.Registry;
	const driverName = name(input.driver);
	const driver = yield* registry.get(driverName);
	const config = yield* registry.decodeCreateConfig(driverName, input.config ?? {});
	return yield* controller.create({ driver, config });
});

export const register = Effect.fn("Sandbox.register")(function* (input: RegisterInput) {
	const controller = yield* SandboxController.Controller;
	const driver = yield* registered(input.driver);
	const runtimeConfig = yield* runtimeOverrides(driver.name, input.runtimeConfig);
	return yield* controller.register({
		driver,
		providerResourceId: input.providerResourceId,
		...(runtimeConfig === undefined ? {} : { runtimeConfig }),
	});
});

export const drivers = Effect.fn("Sandbox.drivers")(function* () {
	const registry = yield* SandboxDriverRegistry.Registry;
	return registry.drivers;
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
		...(input?.driver === undefined ? {} : { driver: name(input.driver) }),
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

export { SandboxInstance };

export * as Sandbox from "./sandbox.ts";
