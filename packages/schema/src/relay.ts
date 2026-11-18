import { Context, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";

// The relay's HTTP API (relay.codework.sh): people call it with an auth-vendor session token, machines
// with requests signed by their own key (see ./jws.ts). The relay implements it; codework is a client.

export const Role = Schema.Literals(["owner", "admin", "member"]);

/** A workspace's id, which the relay assigns; anything else is refused at the wire. */
export const WorkspaceId = Schema.String.check(Schema.isUUID());

/** A machine's id: generated (a UUID) or set with `--machine-id`, lowercase letters, digits and dashes. */
export const MachineId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/));

export class Account extends Schema.Class<Account>("Relay.Account")({
	id: Schema.String,
	email: Schema.String,
	name: Schema.NullOr(Schema.String),
}) {}

export class Workspace extends Schema.Class<Workspace>("Relay.Workspace")({
	id: WorkspaceId,
	name: Schema.String,
	role: Role,
}) {}

export class Me extends Schema.Class<Me>("Relay.Me")({
	account: Account,
	workspaces: Schema.Array(Workspace),
}) {}

/** How a machine got its id: generated on first run, or set with `--machine-id`. */
export const IdSource = Schema.Literals(["generated", "flag"]);

/** What a machine says about itself when it pairs and on every heartbeat. */
export const MachineInfo = Schema.Struct({
	id: MachineId,
	source: IdSource,
	localHostName: Schema.String,
	givenName: Schema.NullOr(Schema.String),
	os: Schema.String,
	arch: Schema.String,
	version: Schema.String,
});
export type MachineInfo = typeof MachineInfo.Type;

export class Machine extends Schema.Class<Machine>("Relay.Machine")({
	...MachineInfo.fields,
	workspaceId: WorkspaceId,
	/** The thumbprint of the key the link is live under; a home holds that key for this workspace. */
	keyId: Schema.String,
	ownerId: Schema.String,
	online: Schema.Boolean,
	lastSeenAt: Schema.NullOr(Schema.String),
}) {}

// Signed machine requests: the body carries one compact JWS whose claims name the operation, so a
// signature made for one endpoint is refused by every other.

export const SignedRequest = Schema.Struct({ jws: Schema.String });

export const PairingClaims = Schema.Struct({
	op: Schema.Literal("pairing.create"),
	iat: Schema.Number,
	machine: MachineInfo,
	/** The workspace the connect started from; the approver may pick another when it is null. */
	workspaceId: Schema.NullOr(WorkspaceId),
});
export type PairingClaims = typeof PairingClaims.Type;

/** A pairing's poll, signed with the key it registered: only that process learns the outcome. */
export const PollClaims = Schema.Struct({
	op: Schema.Literal("pairing.poll"),
	iat: Schema.Number,
});
export type PollClaims = typeof PollClaims.Type;

export const HeartbeatClaims = Schema.Struct({
	op: Schema.Literal("machine.heartbeat"),
	iat: Schema.Number,
	workspaceId: WorkspaceId,
	machine: MachineInfo,
});
export type HeartbeatClaims = typeof HeartbeatClaims.Type;

export const RevokeClaims = Schema.Struct({
	op: Schema.Literal("machine.revoke"),
	iat: Schema.Number,
	/** Used once: a replayed revoke is refused. */
	jti: Schema.String,
	workspaceId: WorkspaceId,
	machineId: MachineId,
});
export type RevokeClaims = typeof RevokeClaims.Type;

export const PairingCreated = Schema.Struct({
	userCode: Schema.String,
	expiresIn: Schema.Int,
	interval: Schema.Int,
});

export const Connected = Schema.Struct({
	machineId: MachineId,
	workspace: Schema.Struct({ id: WorkspaceId, name: Schema.String }),
	owner: Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
});
export type Connected = typeof Connected.Type;

export const PairingStatus = Schema.Union([
	/** `superseded`: another connect for this machine and workspace was activated first. */
	Schema.Struct({ status: Schema.Literals(["pending", "expired", "declined", "superseded"]) }),
	Schema.Struct({ status: Schema.Literal("approved"), connected: Connected }),
]);
export type PairingStatus = typeof PairingStatus.Type;

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
	"Relay.Unauthorized",
	{ message: Schema.String },
	{ httpApiStatus: 401 },
) {}

/** The relay couldn't check the request just now (its auth vendor is unreachable): try again shortly. */
export class Unavailable extends Schema.TaggedError<Unavailable>()(
	"Relay.Unavailable",
	{ message: Schema.String },
	{ httpApiStatus: 503 },
) {}

/** The machine's link to the workspace is gone: revoked, replaced, or its owner left. Reconnect to restore it. */
export class MachineRevoked extends Schema.TaggedError<MachineRevoked>()(
	"Relay.MachineRevoked",
	{ message: Schema.String },
	{ httpApiStatus: 401 },
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
	"Relay.Forbidden",
	{ message: Schema.String },
	{ httpApiStatus: 403 },
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
	"Relay.NotFound",
	{ message: Schema.String },
	{ httpApiStatus: 404 },
) {}

/** A person whose session token the auth vendor verified: only the vendor's subject id. */
export class Person extends Context.Service<Person, { readonly authId: string }>()("relay/Person") {}

/** Verifies a person's bearer session token and provides {@link Person}. */
export class PersonAuth extends HttpApiMiddleware.Service<PersonAuth, { provides: Person; requires: never }>()(
	"relay/PersonAuth",
	{
		security: { bearer: HttpApiSecurity.bearer },
		error: [Unauthorized, Unavailable],
	},
) {}

export class MeGroup extends HttpApiGroup.make("me")
	.add(HttpApiEndpoint.get("get", "/v1/me", { success: Me }))
	.middleware(PersonAuth) {}

/** A machine that ran `codework connect` for a workspace and waits for a member to approve its code. */
export class PendingPairing extends Schema.Class<PendingPairing>("Relay.PendingPairing")({
	userCode: Schema.String,
	machine: MachineInfo,
	/** `approved`: a member approved it and the machine's next poll links it. */
	status: Schema.Literals(["pending", "approved"]),
	/** A machine with this id is already in the workspace; approving replaces its link. */
	replaces: Schema.Boolean,
	createdAt: Schema.String,
	expiresAt: Schema.String,
}) {}

export const WorkspaceName = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64));

/** People create workspaces, and manage pairings and machines in a workspace they belong to. */
export class WorkspaceGroup extends HttpApiGroup.make("workspace")
	.add(
		HttpApiEndpoint.post("create", "/v1/workspaces", {
			payload: Schema.Struct({ name: WorkspaceName }),
			success: Workspace,
		}),
		/** Approves a code; the machine's next poll links it, so it answers with what the machine said. */
		HttpApiEndpoint.post("approve", "/v1/pairings/approve", {
			payload: Schema.Struct({ userCode: Schema.String, workspaceId: WorkspaceId }),
			success: Schema.Struct({ machine: MachineInfo }),
			error: [NotFound, Forbidden],
		}),
		HttpApiEndpoint.get("machines", "/v1/workspaces/:workspaceId/machines", {
			params: { workspaceId: WorkspaceId },
			success: Schema.Array(Machine),
			error: Forbidden,
		}),
		/** The workspace's pending connects, each with the code its machine shows. */
		HttpApiEndpoint.get("pairings", "/v1/workspaces/:workspaceId/pairings", {
			params: { workspaceId: WorkspaceId },
			success: Schema.Array(PendingPairing),
			error: Forbidden,
		}),
		/** Turns a pending connect away; the waiting machine hears it was declined. */
		HttpApiEndpoint.post("decline", "/v1/pairings/decline", {
			payload: Schema.Struct({ userCode: Schema.String, workspaceId: WorkspaceId }),
			error: [NotFound, Forbidden],
		}),
		/** Disconnects a machine from the workspace: its owner, or a workspace owner or admin, may. */
		HttpApiEndpoint.post("remove", "/v1/workspaces/:workspaceId/machines/:machineId/remove", {
			params: { workspaceId: WorkspaceId, machineId: MachineId },
			payload: Schema.Struct({ keyId: Schema.String }),
			error: [NotFound, Forbidden],
		}),
	)
	.middleware(PersonAuth) {}

/** Machines authenticate each request with a signature, not a session. */
export class MachineGroup extends HttpApiGroup.make("machine").add(
	HttpApiEndpoint.post("pair", "/v1/pairings", {
		payload: SignedRequest,
		success: PairingCreated,
		error: [Unauthorized, NotFound],
	}),
	HttpApiEndpoint.post("poll", "/v1/pairings/poll", {
		payload: SignedRequest,
		success: PairingStatus,
		error: [Unauthorized, NotFound],
	}),
	HttpApiEndpoint.post("heartbeat", "/v1/machines/heartbeat", {
		payload: SignedRequest,
		error: [Unauthorized, MachineRevoked],
	}),
	HttpApiEndpoint.post("revoke", "/v1/machines/revoke", {
		payload: SignedRequest,
		error: [Unauthorized, MachineRevoked],
	}),
) {}

export class Api extends HttpApi.make("relay").add(MeGroup).add(WorkspaceGroup).add(MachineGroup) {}
