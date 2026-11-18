import { createClerkClient, verifyToken } from "@clerk/backend";
import { TokenVerificationError } from "@clerk/backend/errors";
import { Config, Context, Effect, Layer, Option, Redacted } from "effect";
import { Relay } from "@codeworksh/schema";

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
		readonly verify: (token: string) => Effect.Effect<string, Relay.Unauthorized | Relay.Unavailable>;
		readonly profile: (authId: string) => Effect.Effect<Profile>;
	}
>()("relay/Clerk") {
	static readonly layer = Layer.effect(
		Clerk,
		Effect.gen(function* () {
			const secretKey = Redacted.value(yield* Config.Redacted("CLERK_SECRET_KEY"));
			// The vendor's API, overridable so the E2E suite can make it unreachable.
			const apiUrl = Option.getOrUndefined(yield* Config.option(Config.String("CLERK_API_URL")));
			const client = createClerkClient({ secretKey, ...(apiUrl === undefined ? {} : { apiUrl }) });
			return Clerk.of({
				verify: Effect.fn("Clerk.verify")(function* (token) {
					// The package's verifyToken resolves to the claims and rejects on any failure. A token it refuses
					// (`token-*`: expired, forged, wrong audience) is the caller's fault; anything else, such as its
					// keys failing to load, means the vendor is out of reach and the client should try again.
					const claims: unknown = yield* Effect.tryPromise({
						try: () => verifyToken(token, { secretKey, ...(apiUrl === undefined ? {} : { apiUrl }) }),
						catch: (cause) =>
							cause instanceof TokenVerificationError && cause.reason.startsWith("token-")
								? new Relay.Unauthorized({ message: "Invalid or expired session token" })
								: new Relay.Unavailable({ message: "CodeWork's sign-in service isn't responding" }),
					});
					if (
						typeof claims !== "object" ||
						claims === null ||
						!("sub" in claims) ||
						typeof claims.sub !== "string"
					) {
						return yield* new Relay.Unauthorized({ message: "Invalid or expired session token" });
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
