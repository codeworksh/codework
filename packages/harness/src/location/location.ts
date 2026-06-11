import { Context, Effect, Layer, Schema } from "effect";
import { Project } from "../project/project";
import { Sandbox } from "../sandbox/sandbox";
import { AbsolutePath } from "../schema";
import { Workspace } from "../workspace/workspace";

export const Ref = Schema.Struct({
	directory: AbsolutePath,
	workspaceID: Schema.optional(Workspace.ID),
}).annotate({ identifier: "Location.Ref" });
export type Ref = typeof Ref.Type;

export class Info extends Schema.Class<Info>("Location.Info")({
	directory: AbsolutePath,
	workspaceID: Schema.optional(Workspace.ID),
	project: Schema.Struct({
		id: Project.ID,
		name: Schema.String,
		vcs: Schema.optional(Project.Vcs),
		directory: AbsolutePath,
	}),
}) {}

export interface Interface extends Info {}

export class Service extends Context.Service<Service, Interface>()("@codework/location") {}

export const layer = (ref: Ref) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const project = yield* Project.Service;
			const resolved = yield* project.fromDirectory(ref.directory);
			return Service.of({
				directory: ref.directory,
				workspaceID: ref.workspaceID,
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
	layer(ref).pipe(Layer.provide(Project.layerWith(sandbox)));

export const defaultLayer = (ref: Ref, path: string) => layer(ref).pipe(Layer.provide(Project.defaultLayer(path)));

export * as Location from "./location";
