import { Schema, Context, Layer, Effect } from "effect";
import { AbsolutePath } from "./schema";
import { Global } from "./global";

export class Info extends Schema.Class<Info>("Config.Info")({
	$schema: Schema.optional(Schema.String).annotate({
		description: "JSON schema reference for configuration validation",
	}),
	model: Schema.String.pipe(Schema.optional).annotate({
		description: "Default model to use when no session or agent model is selected",
	}),
	provider: Schema.String.pipe(Schema.optional).annotate({
		description: "Default provider to use when no session or agent provider is selected",
	}),
}) {}

export const FileSource = Schema.Struct({
	type: Schema.Literal("file"),
	path: Schema.String,
}).annotate({ identifier: "Config.FileSource" });
export type FileSource = typeof FileSource.Type;

export const MemorySource = Schema.Struct({
	type: Schema.Literal("memory"),
}).annotate({ identifier: "Config.MemorySource" });
export type MemorySource = typeof MemorySource.Type;

export const Source = Schema.Union([FileSource, MemorySource]).pipe(Schema.toTaggedUnion("type"));
export type Source = typeof Source.Type;

export class Loaded extends Schema.Class<Loaded>("Config.Loaded")({
	source: Source,
	info: Info,
}) {}

export interface Interface {
	/** Returns supplemental agent config directories from lowest to highest priority. */
	readonly agentDirs: () => Effect.Effect<AbsolutePath[]>;
	/** Loads location config files from lowest to highest priority. */
	readonly get: () => Effect.Effect<Loaded[]>;
}

export class Service extends Context.Service<Service, Interface>()("@codework/config") {}

// export const layer = Layer.effect(
// 	Service,
// 	Effect.gen(function* () {
// 		const global = yield* Global.Service;
// 		const names = ["settings.json", "codework.json", "codework.jsonc"];
// 	}),
// );
