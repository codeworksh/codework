import { Effect, Layer, Redacted } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Accounts } from "./accounts.ts";
import { Api, Person, PersonAuth } from "./api.ts";
import { Clerk } from "./clerk.ts";

const PersonAuthLayer = Layer.effect(
	PersonAuth,
	Effect.gen(function* () {
		const clerk = yield* Clerk;
		return PersonAuth.of({
			bearer: Effect.fn("PersonAuth.bearer")(function* (httpEffect, { credential }) {
				const authId = yield* clerk.verify(Redacted.value(credential));
				return yield* Effect.provideService(httpEffect, Person, { authId });
			}),
		});
	}),
);

const MeHandlers = HttpApiBuilder.group(
	Api,
	"me",
	Effect.fn(function* (handlers) {
		const accounts = yield* Accounts;
		return handlers.handle("get", () =>
			Effect.gen(function* () {
				const person = yield* Person;
				return yield* accounts.ensure(person.authId);
			}),
		);
	}),
).pipe(Layer.provide(PersonAuthLayer));

/** The relay's routes, independent of the runtime that serves them. Requires `SqlClient`. */
export const routes = HttpApiBuilder.layer(Api).pipe(
	Layer.provide(MeHandlers),
	Layer.provide(Accounts.layer),
	Layer.provide(Clerk.layer),
);
