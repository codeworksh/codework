import { createClerkClient, verifyToken } from "@clerk/backend";
import { Config, Context, Effect, Layer, Redacted } from "effect";
import { Unauthorized } from "./api.ts";

export interface Profile {
	readonly email: string;
	readonly firstName: string | null;
	readonly name: string | null;
}

/** The auth vendor, behind the two things the relay needs from it. */
export class Clerk extends Context.Service<
	Clerk,
	{
		/** The verified subject (`auth_id`) of a session token. */
		readonly verify: (token: string) => Effect.Effect<string, Unauthorized>;
		readonly profile: (authId: string) => Effect.Effect<Profile>;
	}
>()("relay/Clerk") {
	static readonly layer = Layer.effect(
		Clerk,
		Effect.gen(function* () {
			const secretKey = Redacted.value(yield* Config.Redacted("CLERK_SECRET_KEY"));
			const client = createClerkClient({ secretKey });
			return Clerk.of({
				verify: Effect.fn("Clerk.verify")(function* (token) {
					// The package's verifyToken resolves to the claims and rejects on any verification failure.
					const claims: unknown = yield* Effect.tryPromise(() => verifyToken(token, { secretKey })).pipe(
						Effect.mapError(() => new Unauthorized({ message: "Invalid or expired session token" })),
					);
					if (
						typeof claims !== "object" ||
						claims === null ||
						!("sub" in claims) ||
						typeof claims.sub !== "string"
					) {
						return yield* new Unauthorized({ message: "Invalid or expired session token" });
					}
					return claims.sub;
				}),
				profile: Effect.fn("Clerk.profile")(function* (authId) {
					const user = yield* Effect.tryPromise(() => client.users.getUser(authId)).pipe(Effect.orDie);
					const email = user.primaryEmailAddress?.emailAddress;
					if (email === undefined)
						return yield* Effect.die(new Error(`Clerk user ${authId} has no email address`));
					return { email, firstName: user.firstName, name: user.fullName };
				}),
			});
		}),
	);
}
