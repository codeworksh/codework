import { Context, Effect, Layer, Schema } from "effect";
import { Project } from "../project/project";
import { ProjectSchema } from "../project/schema";
import { SandboxInstance } from "../sandbox/instance";
import { Sandbox } from "../sandbox/sandbox";
import { AbsolutePath } from "../schema";

/**
 * Where work happens: a directory, qualified by the namespace it lives in.
 *
 * The pair is the key. A path alone does not name a place — `/app/repo` on the
 * host and `/app/repo` inside a remote sandbox are different trees wearing the
 * same spelling — so everything scoped to a location carries both halves.
 * Sessions sharing a pair share the project and its registered directories;
 * `main`, `root`, and worktree relationships stay a Project concern beneath it.
 *
 * With the host the second half is constant, so a Location degenerates to
 * exactly what a path-keyed runtime gives you.
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
	directory: AbsolutePath,
	sandboxInstanceId: SandboxInstance.ID,
	project: Schema.Struct({
		id: ProjectSchema.ID,
		name: Schema.String,
		vcs: Schema.optional(ProjectSchema.Vcs),
		directory: AbsolutePath,
	}),
}) {}

export interface Interface extends Info {}

export class Service extends Context.Service<Service, Interface>()("@codework/location") {}

// `SandboxInstance.Service` in the requirements is what makes "mount first" a
// type-level fact rather than a convention: this Layer cannot be built outside a
// mount, so there is never a Location without one underneath.
export const layer = (ref: Ref = {}) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const instance = yield* SandboxInstance.Service;
			const directory = AbsolutePath.make(ref.directory ?? instance.cwd);
			const project = yield* Project.Service;
			const resolved = yield* project.fromDirectory(directory);
			return Service.of({
				// `directory` is pwd; `project.directory` is the repository root found
				// by walking up from it. Frequently different, and never an input.
				directory,
				sandboxInstanceId: instance.id,
				project: {
					id: resolved.id,
					name: resolved.name,
					vcs: resolved.vcs,
					directory: resolved.directory,
				},
			});
		}),
	);

export const layerWith = <E, RIn>(ref: Ref, sandbox: Sandbox.Sandbox<E, RIn>) =>
	layer(ref).pipe(Layer.provideMerge(Project.layerWith(sandbox)), Layer.provide(sandbox));

export const defaultLayer = (ref: Ref, path: string) =>
	layer(ref).pipe(Layer.provideMerge(Project.defaultLayer(path)), Layer.provide(SandboxInstance.hostLayer(path)));

export * as Location from "./location";
