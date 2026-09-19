import { Effect, Layer, Option, Ref } from "effect";
import { Context } from "../context/context.ts";
import { Control } from "../control.ts";
import { Database } from "../db/db.ts";
import { Event } from "../event/event.ts";
import { Global } from "../global.ts";
import { EventRegistry } from "../event/registry.ts";
import { follow, load, type PluginRef, type Pool } from "../plugin/catalog.ts";
import { PluginSource } from "../plugin/source.ts";
import { PluginStore } from "../plugin/store.ts";
import { builtins } from "../plugin/builtin.ts";
import { RunnerExecute } from "../runner/execute.ts";
import { LLM } from "../runner/llm.ts";
import { Loop } from "../runner/loop.ts";
import { SandboxController } from "../sandbox/control.ts";
import { SandboxDriver } from "../sandbox/driver.ts";
import { MemorySandboxDriver } from "../sandbox/drivers/memory.ts";
import { SqldbSandboxDriver } from "../sandbox/drivers/sqldb.ts";
import { SandboxDriverLoader } from "../sandbox/loader.ts";
import { SandboxDriverRegistry } from "../sandbox/registry.ts";
import { SessionLive } from "../session/live.ts";
import { SessionRuntime } from "../session/runtime.ts";
import type { Info as SettingsInfo } from "../settings/schema.ts";
import { Settings } from "../settings/settings.ts";
import { State } from "../state/state.ts";

export interface Options {
	/**
	 * The complete selection, replacing both the built-ins and whatever `settings.plugins`
	 * asks for -- an embedder that passes this owns the plugin set, and an empty array runs
	 * none. Omit it to get the built-ins plus the settings block.
	 */
	readonly plugins?: ReadonlyArray<PluginRef>;
	readonly database?: string;
	/**
	 * The host directory the project settings layer is discovered from. Defaults to the OS
	 * process's directory; a test or an embedder that runs somewhere other than where it wants
	 * settings read from passes its own, rather than inheriting whatever launched the process.
	 */
	readonly hostCwd?: string;
	readonly home?: string;
	/** user provided directory containing the highest-priority config. */
	readonly userConfigDir?: string;
	readonly sandboxes?: ReadonlyArray<SandboxDriverLoader.Entry>;
	readonly llm?: LLM.Open;
}

export const layer = (options: Options = {}) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const paths = yield* Global.resolve(options.home === undefined ? {} : { home: options.home });
			// The single sanctioned `process.cwd()` in the harness, and only as the default.
			// Everything downstream takes the host directory as a required parameter, so no module
			// can quietly fall back to the OS process's directory when it meant a session's mount.
			const hostCwd = options.hostCwd ?? process.cwd();
			const global = Global.layerWith(paths);
			const settingsOptions = options.userConfigDir === undefined ? {} : { userConfigDir: options.userConfigDir };
			// Settings are read once here because the plugin selection has to be prepared before
			// any layer that depends on it; every later read goes through `Settings.Service`,
			// which discovers from the session's own `hostDir` rather than from this one.
			//
			// This read happens before any session exists, so the process's directory is the only
			// root available -- and the right one: it is what decides which plugins this process
			// loads at all. Which of them a given session *runs* is the per-session question.
			const config = yield* Settings.load({ ...settingsOptions, home: paths.home, hostDir: hostCwd });
			/*
			 * Which entries this process configures from, per exchange.
			 *
			 * Settings entries extend the built-in selection rather than standing in for it, so
			 * naming a plugin cannot silently drop Bash or the default prompt. A built-in is turned
			 * off by name, with a `{ "plugin": "codework.tool.bash", "enabled": false }` entry.
			 *
			 * An embedder that supplied its own list keeps it verbatim: it asked for exactly this
			 * selection, and the files must not add to it behind its back.
			 */
			const references = (settings: SettingsInfo): ReadonlyArray<PluginRef> =>
				options.plugins ?? [...builtins, ...settings.plugins];

			const catalogOptions = { builtins, cache: paths.cache, hostDir: hostCwd };
			// The load pass, once, at boot: a store lookup and an ESM import per module. Every
			// later exchange runs only the config pass over what this produced.
			const pool = yield* Ref.make<Pool>(yield* load(references(config), catalogOptions));

			/*
			 * What the store already holds for a reference, and nothing else.
			 *
			 * Resolve-only by construction: `Store.resolve` never opens a socket, so an exchange
			 * asking this question cannot block on a registry, and `plugin install` stays the only
			 * verb that puts bytes on disk. A reference that does not parse, or names a local
			 * path, is simply not filed.
			 */
			const filed = (reference: string): Effect.Effect<Option.Option<PluginStore.Entry>> =>
				PluginSource.parse(reference, hostCwd).pipe(
					Effect.flatMap((target) =>
						target.kind === "local"
							? Effect.succeedNone
							: PluginStore.resolve(target, paths.cache).pipe(Effect.map(Option.fromUndefinedOr)),
					),
					Effect.orElseSucceed(() => Option.none<PluginStore.Entry>()),
				);

			// Resolve-only for the same reason: an exchange follows the store, it does not fill it.
			const followStore = (refs: ReadonlyArray<PluginRef>, current: Pool) =>
				follow(refs, current, { ...catalogOptions, install: PluginStore.required }, filed);
			// Flattened before anything can publish: a plugin event type that collides
			// or is not namespaced is a boot failure, not a surprise at first publish.
			const definitions = yield* EventRegistry.flatten([...(yield* Ref.get(pool)).plugins.values()]);
			const configuredDatabase = options.database ?? (yield* Database.locationConfig);
			const database = Database.layer(Database.resolveDatabaseLocation(configuredDatabase, paths.data));
			const configured = yield* SandboxDriverLoader.loadAll(options.sandboxes ?? [], { hostCwd });
			const drivers = SandboxDriverRegistry.layer(
				SandboxDriver.withSource(MemorySandboxDriver.make().driver, "core"),
				SandboxDriver.withSource(SqldbSandboxDriver.make().driver, "core"),
				...configured,
			);
			const sandboxes = SandboxController.layer().pipe(Layer.provideMerge(drivers), Layer.provideMerge(database));
			const loop = options.llm === undefined ? Loop.layer() : Loop.layer({ request: LLM.make(options.llm) });

			return Control.layer.pipe(
				Layer.provideMerge(RunnerExecute.layer.pipe(Layer.provide(loop))),
				Layer.provideMerge(State.layer({}, pool, references, followStore)),
				Layer.provideMerge(Settings.layer(settingsOptions)),
				Layer.provideMerge(SessionRuntime.layer),
				Layer.provideMerge(sandboxes),
				Layer.provideMerge(Context.layer),
				Layer.provideMerge(SessionLive.layer),
				Layer.provideMerge(Event.layer),
				Layer.provideMerge(EventRegistry.layer(definitions)),
				Layer.provideMerge(database),
				Layer.provideMerge(global),
			);
		}),
	);

export * as Harness from "./harness.ts";
