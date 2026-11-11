import { SpaceSkill, type SpaceSkills } from "@codeworksh/contract";
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { Codework } from "./codework.ts";
import { Reads } from "./reads.ts";

const Stored = Schema.fromJsonString(Schema.Array(SpaceSkill));
const encode = Schema.encodeSync(Stored);
const decode = Schema.decodeUnknownOption(Stored);

/**
 * Each active space's skills, read live where that costs nothing: the host every time, a sandbox
 * only while CodeWork reports it running. Every read is kept, so a stopped sandbox, or a server that
 * is down, shows the last one with when it was taken.
 */
export const list = Effect.fn("Skills.list")(function* (input: {
	readonly machineId: string;
	readonly projectId: string;
}) {
	const sql = yield* SqlClient.SqlClient;
	const spaces = (yield* Reads.spaces(input)).filter((space) => space.status === "active");
	return yield* Effect.forEach(
		spaces,
		Effect.fnUntraced(function* (space) {
			// Mounting a running sandbox can take a while; the host answers at once.
			const live = yield* Codework.call((client) => client("skill.list", { spaceId: space.id }), {
				timeout: "30 seconds",
			}).pipe(Effect.option);
			const sandbox = Option.isSome(live) ? live.value.sandbox : null;
			if (Option.isSome(live) && live.value.skills !== null) {
				const skills = live.value.skills.map(({ name, description, hidden }) => ({ name, description, hidden }));
				const syncedAt = Date.now();
				yield* sql`
					INSERT INTO skill (machine_id, space_id, skills, synced_at)
					VALUES (${input.machineId}, ${space.id}, ${encode(skills)}, ${syncedAt})
					ON CONFLICT (machine_id, space_id) DO UPDATE SET skills = excluded.skills, synced_at = excluded.synced_at
				`.pipe(Effect.orDie);
				return { space, sandbox, skills, syncedAt } satisfies SpaceSkills;
			}
			const [kept] = yield* sql<{ skills: string; syncedAt: number }>`
				SELECT skills, synced_at AS "syncedAt" FROM skill
				WHERE machine_id = ${input.machineId} AND space_id = ${space.id}
			`.pipe(Effect.orDie);
			const skills = kept === undefined ? Option.none() : decode(kept.skills);
			return {
				space,
				sandbox,
				skills: Option.getOrNull(skills),
				syncedAt: Option.isSome(skills) && kept !== undefined ? kept.syncedAt : null,
			} satisfies SpaceSkills;
		}),
		{ concurrency: "unbounded" },
	);
});

export * as Skills from "./skills.ts";
