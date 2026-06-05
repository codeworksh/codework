import { Schema, Context, Layer, Effect } from "effect";
import { Workspace } from "./workspace";
import { Slug } from "../util/slug";

export const Ref = Schema.Struct({
	workspaceID: Workspace.ID,
	name: Schema.optional(Schema.String),
}).annotate({ identifier: "Space.Ref" });
export type Ref = typeof Ref.Type;

export class Info extends Schema.Class<Info>("Space.Info")({
	workspaceID: Workspace.ID,
	name: Schema.String,
}) {}

export interface Interface extends Info {
	readonly workspaceID: Workspace.ID;
	name: string;
}

export class Service extends Context.Service<Service, Interface>()("@codework/space") {}

export const layer = (ref: Ref) =>
	Layer.effect(
		Service,
		Effect.sync(() =>
			Service.of({
				workspaceID: ref.workspaceID,
				name: ref.name ?? Slug.create(),
			}),
		),
	);
