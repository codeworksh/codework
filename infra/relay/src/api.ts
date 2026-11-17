import { Context, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";

export const Role = Schema.Literals(["owner", "admin", "member"]);

export class Account extends Schema.Class<Account>("Account")({
	id: Schema.String,
	email: Schema.String,
	name: Schema.NullOr(Schema.String),
}) {}

export class Workspace extends Schema.Class<Workspace>("Workspace")({
	id: Schema.String,
	name: Schema.String,
	role: Role,
}) {}

export class Me extends Schema.Class<Me>("Me")({
	account: Account,
	workspaces: Schema.Array(Workspace),
}) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
	"Unauthorized",
	{ message: Schema.String },
	{ httpApiStatus: 401 },
) {}

/** A person whose session token the auth vendor verified: only the vendor's subject id. */
export class Person extends Context.Service<Person, { readonly authId: string }>()("relay/Person") {}

/** Verifies a person's bearer session token and provides {@link Person}. */
export class PersonAuth extends HttpApiMiddleware.Service<PersonAuth, { provides: Person; requires: never }>()(
	"relay/PersonAuth",
	{
		security: { bearer: HttpApiSecurity.bearer },
		error: Unauthorized,
	},
) {}

export class MeGroup extends HttpApiGroup.make("me")
	.add(HttpApiEndpoint.get("get", "/v1/me", { success: Me }))
	.middleware(PersonAuth) {}

export class Api extends HttpApi.make("relay").add(MeGroup) {}
