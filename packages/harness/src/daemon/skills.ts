/**
 * The builtin skills daemon: keeps the skills a space's sessions can see current, read exactly the
 * way the skill prompt plugin reads them (`.codework/skills` at the space's folder, `.agents/skills`
 * up to the git root), through the space's own filesystem. Publishes `plugin.skills.list` when the
 * list changed.
 */
import { Daemon } from "@codeworksh/plugin/plugin";
import { Effect, References, Schema } from "effect";
import * as EventList from "../event/list.ts";
import { EventSchema } from "../event/schema.ts";
import * as Skill from "../plugin/builtin/prompt/skill.ts";

const Found = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	path: Schema.String,
	/** Its frontmatter keeps it out of the prompt. */
	hidden: Schema.Boolean,
});

export const List = EventSchema.define({
	type: "plugin.skills.list",
	schema: {
		spaceId: Schema.String,
		observedAt: Schema.Int,
		skills: Schema.Array(Found),
	},
});
export type List = typeof List.Type;

const keyOf = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const daemon = Daemon.define({
	id: "skills",
	kind: "daemon",
	scope: "space",
	events: [List],
	start: (ctx) =>
		Effect.gen(function* () {
			let last: string | undefined;
			const refresh = ctx.io.use(({ fs }) =>
				Effect.gen(function* () {
					// The skill prompt plugin reports a broken skill file each turn; this read stays quiet.
					const discovered = yield* Skill.discover(fs, ctx.space.location).pipe(
						Effect.provideService(References.MinimumLogLevel, "Error"),
					);
					const skills = discovered.map((skill) => ({
						name: skill.name,
						description: skill.description,
						path: skill.filePath,
						hidden: skill.disableModelInvocation,
					}));
					const key = yield* keyOf(skills).pipe(Effect.orDie);
					if (key === last) return;
					yield* ctx.events.publish(List, { skills });
					last = key;
				}),
			);
			const list = yield* ctx.work("list", refresh);
			yield* ctx.events.on(
				[EventList.SpaceMountAttached, EventList.TurnEnded, EventList.SpaceMountDetached],
				() => list.mark,
			);
		}),
});
