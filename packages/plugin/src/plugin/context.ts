import type { Model } from "@codeworksh/aikit";
import type { Effect } from "effect";
import type { Data, Definition, Payload, PublishOptions } from "../event.ts";
import type { SessionID } from "../ids.ts";
import type { Info as LocationInfo } from "../location.ts";
import type { SandboxIO } from "../sandbox/io.ts";
import type { Info as SettingsInfo } from "../settings.ts";
import type { PluginRegistry } from "./registry.ts";

export type PromptResolver = (ctx: SharedPluginContext) => string | Promise<string>;

export interface Config {
	readonly promptCustom?: PromptResolver;
	readonly promptSystemAppend?: PromptResolver;
}

/**
 * The publish half of the harness event bus.
 *
 * Narrowed to `publish` on purpose: a plugin announces what it did, it does not read the journal.
 * Kernel event types are reserved — the harness rejects a plugin publishing one — so a plugin's
 * own definitions must be namespaced `plugin.<id>.*`.
 */
export interface Events {
	readonly publish: <D extends Definition>(
		definition: D,
		data: Data<D>,
		options?: PublishOptions,
	) => Effect.Effect<Payload<D>>;
}

/** One object, shared by every plugin in one exchange. */
export interface SharedPluginContext {
	readonly sessionId: SessionID;
	readonly sandbox: SandboxIO.Identity;
	readonly location: LocationInfo;
	readonly settings: SettingsInfo;
	readonly model: Model.Info;
	readonly config: Config;
	readonly events: Events;
	readonly plugin: PluginRegistry;
}
