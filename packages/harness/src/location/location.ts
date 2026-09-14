import { Context, Effect, Layer, Schema } from "effect";
import { Database } from "../db/db.ts";
import { Git } from "../git/git.ts";
import { Project } from "../project/project.ts";
import { ProjectSchema } from "../project/schema.ts";
import { Repo } from "../repo/repo.ts";
import { SandboxIO } from "../sandbox/io.ts";
import { Sandbox } from "../sandbox/sandbox.ts";
import { AbsolutePath, RelativePath } from "../schema.ts";
import { SpaceSchema } from "../space/schema.ts";
import { Space } from "../space/space.ts";
import { posix } from "../util/posix.ts";
import { Worktree } from "../worktree/worktree.ts";

/**
 * Where work happens: a directory inside a space.
 *
 * The pair (space, directory) is the key. A path alone does not name a place —
 * `/app/repo` on the host and `/app/repo` inside a remote sandbox are different
 * trees wearing the same spelling — so the space carries the env and the
 * absolute location, and `directory` is relative to it (`""` = root). Sessions
 * sharing a space share the project; worktree relationships stay a Project
 * concern beneath it.
 *
 * **Both halves come from the mount, so `Ref` is overrides and nothing else.**
 * A Location is a directory *within* a mounted namespace — the mount has to be
 * resolved first, the way a volume is mounted before any path on it means
 * anything — and once it is, the namespace and the working directory are already
 * in scope. Re-declaring them would be two spellings of one value, free to drift;
 * a Location pointing somewhere its own shell is not becomes unrepresentable
 * rather than merely avoided by discipline.
 */
export const Ref = Schema.Struct({
	/** Defaults to the mount's cwd. Set it to work in a subdirectory of the mount. */
	directory: Schema.optional(AbsolutePath),
}).annotate({ identifier: "Location.Ref" });
export type Ref = typeof Ref.Type;

export class Info extends Schema.Class<Info>("Location.Info")({
	/** Relative to `space.location`; `""` at the space root. */
	directory: RelativePath,
	space: SpaceSchema.Info,
	project: ProjectSchema.Info,
}) {}

/** The absolute cwd tools run in: `space.location` joined with `directory`. */
export const cwd = (info: Info) => AbsolutePath.make(posix.join(info.space.location, info.directory));

export interface Interface extends Info {}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/location/location/Service") {}

// `SandboxIO.Current` in the requirements is what makes "mount first" a
// type-level fact rather than a convention: this Layer cannot be built outside a
// mount, so there is never a Location without one underneath.
export const layer = (ref: Ref = {}) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const instance = yield* SandboxIO.Current;
			const directory = AbsolutePath.make(ref.directory ?? instance.cwd);
			const project = yield* Project.Service;
			const resolved = yield* project.resolveOrCreate(directory);
			return Service.of(
				new Info({ directory: resolved.directory, space: resolved.space, project: resolved.project }),
			);
		}),
	);

/**
 * `layer` with the whole resolution stack (Project, Space, Repo, Worktree, Git)
 * folded in. What remains is exactly the mount and the database — for callers
 * that already hold both, such as the runner and `Session.create`.
 */
export const layerMounted = (ref: Ref = {}) =>
	layer(ref).pipe(
		Layer.provide(
			Project.layer.pipe(
				Layer.provide(Layer.mergeAll(Repo.layer, Worktree.layer, Space.layer)),
				Layer.provide(Git.layer),
			),
		),
	);

export const layerWith = <E, RIn>(ref: Ref, sandbox: Sandbox.Sandbox<E, RIn>) =>
	layerMounted(ref).pipe(Layer.provide(sandbox), Layer.provide(Database.defaultLayer));

export const defaultLayer = (ref: Ref, path: string) => layerWith(ref, Sandbox.defaultLayer(path));

export * as Location from "./location.ts";
