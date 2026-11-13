import { Effect, Option, Schema } from "effect";
import * as Skill from "../plugin/builtin/prompt/skill.ts";
import * as Project from "../project/project.ts";
import * as SandboxController from "../sandbox/control.ts";
import { SandboxInstance } from "../sandbox/instance.ts";
import { SandboxIO } from "../sandbox/io.ts";

export class SpaceNotFoundError extends Schema.TaggedError<SpaceNotFoundError>()("SpaceNotFoundError", {
	spaceId: Schema.String,
}) {}

export interface Found {
	readonly name: string;
	readonly description: string;
	readonly path: string;
	/** Its frontmatter keeps it out of the prompt. */
	readonly hidden: boolean;
}

/** The sandbox a space is in, as last observed; absent for the host. */
export interface Placement {
	readonly driver: string;
	readonly providerResourceId: string | undefined;
	readonly status: SandboxInstance.Status;
}

export interface Listed {
	readonly sandbox: Placement | undefined;
	/** Absent when the sandbox is not running: listing never wakes one. */
	readonly skills: ReadonlyArray<Found> | undefined;
}

const placement = (info: SandboxInstance.Info): Placement => ({
	driver: info.driver,
	providerResourceId: Option.getOrUndefined(info.providerResourceId),
	status: info.status,
});

/**
 * The skills sessions in a space see from its folder, read the way the skill plugin reads them. A
 * sandbox is read only while it is running; one that is stopped, expired or unreachable is left as
 * it is and reported with its last observed state.
 */
export const list = Effect.fn("Skill.list")(function* (spaceId: string) {
	const space = yield* Project.space(spaceId);
	if (space === undefined) return yield* new SpaceNotFoundError({ spaceId });
	const read = Effect.gen(function* () {
		const fs = yield* SandboxIO.FileSystem;
		const skills = yield* Skill.discover(fs, space.location);
		return skills.map((skill): Found => ({
			name: skill.name,
			description: skill.description,
			path: skill.filePath,
			hidden: skill.disableModelInvocation,
		}));
	});
	const controller = yield* SandboxController.Controller;
	if (space.env === null) {
		const skills = yield* controller.withMount(undefined, read, { cwd: space.location });
		return { sandbox: undefined, skills } satisfies Listed;
	}
	const id = SandboxInstance.ID.make(space.env);
	// A fresh state when the driver can give one without waking the sandbox, else the last observed.
	const info = yield* controller.refresh(id).pipe(
		Effect.asSome,
		Effect.catch(() => controller.get(id)),
		Effect.orElseSucceed(() => Option.none<SandboxInstance.Info>()),
	);
	if (Option.isNone(info)) return yield* new SpaceNotFoundError({ spaceId });
	const sandbox = placement(info.value);
	if (sandbox.status !== "online") return { sandbox, skills: undefined } satisfies Listed;
	const skills = yield* controller.withMount(id, read, { cwd: space.location });
	return { sandbox, skills } satisfies Listed;
});
