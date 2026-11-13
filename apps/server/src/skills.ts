import { type CodeworkUnavailable, SpaceSkill, type SpaceSkills } from "@codeworksh/contract";
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { Codework } from "@codeworksh/widget/backend";
import { Reads } from "./reads.ts";

const Stored = Schema.fromJsonString(Schema.Struct({ skills: Schema.Array(SpaceSkill) }));
const decode = Schema.decodeUnknownOption(Stored);

/**
 * Each active space's skills as its skills daemon last published them, mirrored from CodeWork's
 * event stream: nothing here reads a space. `syncedAt` is when the daemon read them, so a stopped
 * sandbox shows its last list and how old it is.
 */
export const list = Effect.fn("Skills.list")(function* (
	input: { readonly machineId: string; readonly projectId: string },
	/** The machine's own connection: its sandboxes are not the default machine's. */
	machine: Effect.Effect<typeof Codework.Service, CodeworkUnavailable>,
) {
	const sql = yield* SqlClient.SqlClient;
	const spaces = (yield* Reads.spaces(input)).filter((space) => space.status === "active");
	// Sandbox rows from CodeWork's store, never from a sandbox: listing them wakes nothing.
	const sandboxes = yield* machine.pipe(
		Effect.flatMap((client) => client("sandbox.list", {})),
		Effect.timeout("10 seconds"),
		Effect.orElseSucceed(() => []),
	);
	const kept = yield* sql<{ spaceId: string; data: string; observedAt: number }>`
		SELECT space_id, data, observed_at FROM space_state
		WHERE machine_id = ${input.machineId} AND type = 'plugin.skills.list'
	`.pipe(Effect.orDie);
	return spaces.map((space): SpaceSkills => {
		const row = kept.find((state) => state.spaceId === space.id);
		const stored = row === undefined ? Option.none() : decode(row.data);
		const sandbox = space.env === null ? undefined : sandboxes.find((info) => info.id === space.env);
		return {
			space,
			sandbox:
				sandbox === undefined
					? null
					: {
							driver: sandbox.driver,
							providerResourceId: Option.getOrNull(sandbox.providerResourceId),
							status: sandbox.status,
						},
			skills: Option.match(stored, {
				onNone: () => null,
				onSome: (value) => value.skills.map(({ name, description, hidden }) => ({ name, description, hidden })),
			}),
			syncedAt: Option.isSome(stored) && row !== undefined ? row.observedAt : null,
		};
	});
});

export * as Skills from "./skills.ts";
