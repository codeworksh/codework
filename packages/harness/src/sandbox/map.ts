import { Context, Effect, Layer, LayerMap, Schema } from "effect";
import { SandboxEnv } from "./env";
import { SandboxInstance } from "./instance";
import { EnvDaytona } from "./providers/daytona";
import { EnvVercel } from "./providers/vercel";
import { Sandbox } from "./sandbox";

/**
 * Resolves a persisted `sandbox_env_id` back into a live sandbox.
 *
 * A session or directory row records the namespace it belongs to; this is what
 * turns that address into the filesystem and shell that act on it. Built on
 * `LayerMap`, so each environment is constructed on demand, shared by every
 * concurrent user of the same id, and released once idle — which matters when
 * "constructing" means provisioning a remote microVM.
 *
 * Only reattachable addresses resolve. An ephemeral namespace is built directly
 * by its constructor (`Sandbox.memory()`), never looked up: resolving one would
 * hand back an empty namespace wearing the right name, which reads as success
 * and is not.
 */

export class SandboxUnavailable extends Schema.TaggedErrorClass<SandboxUnavailable>()("SandboxUnavailable", {
	envId: Schema.String,
	reason: Schema.String,
}) {}

export interface Options {
	/** Root for the `local` environment. Defaults to the process working directory. */
	readonly cwd?: string;
	/** Credentials and shape for Vercel environments; the address supplies which box. */
	readonly vercel?: EnvVercel.Options;
	/** Credentials and shape for Daytona environments; the address supplies which box. */
	readonly daytona?: EnvDaytona.Options;
}

/**
 * Address → sandbox. Options carry credentials and never come from the address,
 * so an id stays safe to persist and to log.
 */
// One return type across every branch: `ROut` is contravariant, so a backend
// providing more than `Provides` still satisfies it.
type Resolved = Layer.Layer<Sandbox.Provides, SandboxUnavailable | EnvVercel.VercelError | EnvDaytona.DaytonaError>;

const unavailable = (envId: string, reason: string): Resolved => {
	// Annotated so `unwrap` can see which Layer it is failing to produce; a bare
	// `Effect.fail` succeeds with `never` and infers nothing.
	const failure: Effect.Effect<Resolved, SandboxUnavailable> = Effect.fail(new SandboxUnavailable({ envId, reason }));
	return Layer.unwrap(failure);
};

const build = (envId: string, options: Options): Resolved => {
	const address = SandboxEnv.parse(envId);
	if (address === undefined) return unavailable(envId, `Invalid sandbox environment address "${envId}"`);
	if (!SandboxEnv.isReattachable(address)) {
		return unavailable(
			envId,
			`Environment "${envId}" is ephemeral and cannot be resolved; construct it directly instead`,
		);
	}

	// The address is handed down as the instance identity so the key and the
	// injected `SandboxInstance.Service` agree. That equivalence is this module's
	// alone, and it retires with this module once the Controller mints IDs.
	const instanceId = SandboxInstance.ID.make(envId);

	switch (address.kind) {
		case "local":
			return Sandbox.local(options.cwd ?? process.cwd());
		case "sqldb":
			return Sandbox.sqldb({ location: address.instance, instanceId });
		case "vercel":
			return EnvVercel.layer({ ...options.vercel, sandboxName: address.instance, instanceId });
		case "daytona":
			return EnvDaytona.layer({ ...options.daytona, sandboxId: address.instance, instanceId });
		// `memory` is never reattachable, so it is rejected above.
		case "memory":
			return unavailable(envId, `Environment "${envId}" is ephemeral`);
	}
};

type Map = LayerMap.LayerMap<
	string,
	Sandbox.Provides,
	SandboxUnavailable | EnvVercel.VercelError | EnvDaytona.DaytonaError
>;

export class SandboxMap extends Context.Service<SandboxMap, Map>()("@codework/sandbox/map") {
	/** The sandbox for an id, as a Layer ready to provide to a program. */
	static get(envId: string) {
		return Layer.unwrap(Effect.map(SandboxMap, (map) => map.get(envId)));
	}
}

export const layer = (options: Options = {}) =>
	Layer.effect(
		SandboxMap,
		LayerMap.make((envId: string) => build(envId, options), {
			// Long enough that consecutive operations reuse the same attached
			// client/resources; providers retain ownership of remote box lifetime.
			idleTimeToLive: "5 minutes",
		}),
	);

export * as SandboxRegistry from "./map";
