import { Schema } from "effect";
import { AbsolutePath } from "../../schema";
import { Workspace } from "../workspace";

export const Ref = Schema.Struct({
	directory: AbsolutePath,
	workspaceID: Schema.optional(Workspace.ID),
}).annotate({ identifier: "Location.Ref" });
export type Ref = typeof Ref.Type;

export class Info extends Schema.Class<Info>("Location.Info")({
	directory: AbsolutePath,
	workspaceID: Workspace.ID.pipe(Schema.optional),
	project: Schema.Struct({
		directory: AbsolutePath,
		// TODO: link ProjectID
	}),
}) {}
