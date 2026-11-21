import { Relay } from "@codeworksh/schema";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Accounts } from "./accounts.ts";
import { Clerk } from "./clerk.ts";
import { Machines } from "./machines.ts";

const PersonAuthLayer = Layer.effect(
	Relay.PersonAuth,
	Effect.gen(function* () {
		const clerk = yield* Clerk;
		return Relay.PersonAuth.of({
			bearer: Effect.fn("PersonAuth.bearer")(function* (httpEffect, { credential }) {
				const authId = yield* clerk.verify(Redacted.value(credential));
				return yield* Effect.provideService(httpEffect, Relay.Person, { authId });
			}),
		});
	}),
);

const MeHandlers = HttpApiBuilder.group(
	Relay.Api,
	"me",
	Effect.fn(function* (handlers) {
		const accounts = yield* Accounts;
		return handlers.handle("get", () =>
			Effect.gen(function* () {
				return yield* accounts.ensure((yield* Relay.Person).authId);
			}),
		);
	}),
).pipe(Layer.provide(PersonAuthLayer));

const WorkspaceHandlers = HttpApiBuilder.group(
	Relay.Api,
	"workspace",
	Effect.fn(function* (handlers) {
		const machines = yield* Machines;
		const accounts = yield* Accounts;
		return handlers
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					return yield* accounts.createWorkspace((yield* Relay.Person).authId, payload.name);
				}),
			)
			.handle("approve", ({ params, payload }) =>
				Effect.gen(function* () {
					return yield* machines.approve((yield* Relay.Person).authId, payload.userCode, params.workspaceId);
				}),
			)
			.handle("machines", ({ params }) =>
				Effect.gen(function* () {
					return yield* machines.list((yield* Relay.Person).authId, params.workspaceId);
				}),
			)
			.handle("pairings", ({ params }) =>
				Effect.gen(function* () {
					return yield* machines.pairings((yield* Relay.Person).authId, params.workspaceId);
				}),
			)
			.handle("decline", ({ params, payload }) =>
				Effect.gen(function* () {
					return yield* machines.decline((yield* Relay.Person).authId, payload.userCode, params.workspaceId);
				}),
			)
			.handle("remove", ({ params, payload }) =>
				Effect.gen(function* () {
					return yield* machines.remove(
						(yield* Relay.Person).authId,
						params.workspaceId,
						params.machineId,
						payload.keyId,
					);
				}),
			);
	}),
).pipe(Layer.provide(PersonAuthLayer));

const MachineHandlers = HttpApiBuilder.group(
	Relay.Api,
	"machine",
	Effect.fn(function* (handlers) {
		const machines = yield* Machines;
		return handlers
			.handle("pair", ({ payload }) => machines.pair(payload.jws))
			.handle("poll", ({ payload }) => machines.poll(payload.jws))
			.handle("heartbeat", ({ payload }) => machines.heartbeat(payload.jws))
			.handle("revoke", ({ payload }) => machines.revoke(payload.jws));
	}),
);

/** The desktop app's renderer origins: packaged, and an unpackaged run. */
const desktopOrigins = ["codework://app", "codeworkdev://app"];

/** The relay's routes, independent of the runtime that serves them. Requires `SqlClient`. */
export const routes = Layer.mergeAll(
	HttpApiBuilder.layer(Relay.Api).pipe(
		Layer.provide([MeHandlers, WorkspaceHandlers, MachineHandlers]),
		Layer.provide(Machines.layer),
		Layer.provideMerge(Accounts.layer),
		Layer.provide(Clerk.layer),
	),
	HttpRouter.cors({
		allowedOrigins: desktopOrigins,
		allowedMethods: ["GET", "POST"],
		// Effect's HTTP client also sends trace context with every request.
		allowedHeaders: ["authorization", "content-type", "b3", "traceparent", "tracestate"],
	}),
);
