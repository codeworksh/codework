import { Effect, Layer } from "effect";
import { Database } from "../db/db.ts";
import { Git } from "../git/git.ts";
import { Project } from "../project/project.ts";
import { Repo } from "../repo/repo.ts";
import { SandboxIO } from "../sandbox/io.ts";
import { Sandbox } from "../sandbox/sandbox.ts";
import { AbsolutePath } from "../schema.ts";
import { Space } from "../space/space.ts";
import { Worktree } from "../worktree/worktree.ts";
import { Info, type Ref, Service } from "@codeworksh/plugin/location";

/**
 * Where work happens: a directory inside a space.
 *
 * The shape (`Ref`, `Info`) and the service tag live in `@codeworksh/plugin`, because a resolved
 * `Info` is on every plugin context and `Service` is half of a plugin's `Mount`. Resolving one
 * needs Project, Space, Repo, Worktree and Git, so the layers stay here.
 */
export {
	DirectoryNotFoundError,
	type Error,
	Info,
	type Interface,
	NotDirectoryError,
	Ref,
	Service,
} from "@codeworksh/plugin/location";

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
