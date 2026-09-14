import { Schema } from "effect";
import { ProjectSchema } from "../project/schema.ts";
import { SandboxInstance } from "../sandbox/instance.ts";
import { AbsolutePath } from "../schema.ts";

// hash(env, location) — no project component, so re-pointing a space to
// another project never rewrites the key sessions reference.
export const ID = Schema.String.pipe(Schema.brand("Space.ID"));
export type ID = typeof ID.Type;

// primary: the main checkout (one per project+env); linked: a git worktree
// sharing the primary's store; copy: another clone; plain: a non-git directory.
export const Kind = Schema.Literals(["primary", "linked", "copy", "plain"]);
export type Kind = typeof Kind.Type;

export const Status = Schema.Literals(["active", "archived"]);
export type Status = typeof Status.Type;

// One directory in one env that belongs to a project; the unit sessions attach to.
export class Info extends Schema.Class<Info>("Space.Info")({
	id: ID,
	projectId: ProjectSchema.ID,
	location: AbsolutePath,
	kind: Kind,
	env: SandboxInstance.ID,
	status: Status,
}) {}

export * as SpaceSchema from "./schema.ts";
