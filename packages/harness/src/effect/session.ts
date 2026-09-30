import type { Model } from "@codeworksh/aikit";
import { DateTime, Effect, Option, Stream } from "effect";
import * as Control from "../control.ts";
import * as Event from "../event/event.ts";
import { EventList } from "../event/list.ts";
import type { EventSchema } from "../event/schema.ts";
import { Location } from "../location/location.ts";
import * as SandboxController from "../sandbox/control.ts";
import { SandboxInstance as SandboxInstanceSchema } from "../sandbox/instance.ts";
import { SandboxIO } from "../sandbox/io.ts";
import { AbsolutePath } from "../schema.ts";
import { SessionMessageSchema } from "../session/message/schema.ts";
import type { Delivery } from "../session/prompt/schema.ts";
import { PromptSchema } from "../session/prompt/schema.ts";
import * as SessionRuntime from "../session/runtime.ts";
import { SessionSchema } from "../session/schema.ts";
import { Session as SessionStore } from "../session/session.ts";
import { State } from "../state/state.ts";
import { rooted } from "../util/path.ts";
import type { Info as SandboxInfo } from "./sandbox.ts";

export interface ModelConfig {
	readonly provider: string;
	readonly id: string;
	readonly options?: State.RequestOptions;
}

export interface ToolsConfig {
	readonly execution?: State.ToolExecutionMode;
}

export interface SystemPromptConfig {
	readonly custom?: State.Options["promptCustom"];
	readonly append?: State.Options["promptSystemAppend"];
}

export interface RuntimeInput {
	readonly model?: ModelConfig;
	readonly thinkingLevel?: Model.ThinkingLevel;
	readonly tools?: ToolsConfig;
	readonly systemPrompt?: SystemPromptConfig;
}

export interface CreateInput extends RuntimeInput {
	readonly title?: string;
	readonly sandbox?: SandboxInfo;
	readonly directory?: string;
	/**
	 * The host directory anchor this session belongs to: also the place where its
	 * settings are discovered from.
	 * A host path on the machine the harness runs on, unrelated to
	 * {@link CreateInput.directory}, which names a place inside the session's space.
	 *
	 * Optional, with no fallback. Omitting it gives a session no project layer, which is normal
	 * for a client that has no host project to name; it does *not* silently adopt the process's
	 * own directory. {@link link} assigns one afterwards.
	 */
	readonly hostDir?: string;
}

export interface AttachInput extends RuntimeInput {
	readonly sessionId: SessionSchema.ID;
}

export interface RelinkInput {
	readonly sessionId: SessionSchema.ID;
	readonly sandbox?: SandboxInfo;
	readonly directory?: string;
}

interface PromptOptions {
	readonly delivery?: Delivery;
	readonly id?: SessionMessageSchema.ID;
}

/** Text, or ordered text and image parts. Images are checked before anything is saved. */
export type PromptInput =
	| string
	| (PromptOptions & { readonly text: string })
	| (PromptOptions & { readonly parts: ReadonlyArray<PromptSchema.Part> });

type Admission = ReturnType<Control.Interface["prompt"]>;
type PromptResult = Effect.Effect<Effect.Success<Admission>, Effect.Error<Admission> | PromptSchema.InvalidPromptError>;

export interface Info {
	readonly id: SessionSchema.ID;
	readonly title: string;
	readonly directory: AbsolutePath;
	/** Absent when the session has no host anchor; see {@link CreateInput.hostDir}. */
	readonly hostDir?: AbsolutePath;
	/**
	 * Whether this session has a host anchor at all.
	 */
	readonly hasHostLink: boolean;
	readonly sandbox?: SandboxInfo;
}

export interface Handle {
	readonly id: SessionSchema.ID;
	readonly active: Effect.Effect<boolean>;
	readonly info: Effect.Effect<Info, SessionStore.SessionNotFoundError>;
	readonly prompt: (input: PromptInput) => PromptResult;
	readonly run: (input: PromptInput) => PromptResult;
	readonly wait: () => ReturnType<Control.Interface["wait"]>;
	readonly resume: () => ReturnType<Control.Interface["resume"]>;
	/** Stops active work and waits for its cleanup; idle is a no-op returning false. */
	readonly interrupt: () => ReturnType<Control.Interface["interrupt"]>;
	/** Live session notifications. Use Event.log for durable replay. */
	readonly events: () => Stream.Stream<EventSchema.Payload, Event.SubscriptionOverflowError>;
	readonly path: () => Effect.Effect<ReadonlyArray<SessionStore.HydratedEntry>>;
}

/** What stays in this process. The model and thinking level are the session's {@link chosen} config. */
const runtimeBindings = (input: RuntimeInput): SessionRuntime.Bindings => ({
	...input.model?.options,
	...(input.tools?.execution === undefined ? {} : { toolExecution: input.tools.execution }),
	...(input.systemPrompt?.custom === undefined ? {} : { promptCustom: input.systemPrompt.custom }),
	...(input.systemPrompt?.append === undefined ? {} : { promptSystemAppend: input.systemPrompt.append }),
});

/** The keys of the session's durable config this input names. */
const chosen = (input: RuntimeInput): SessionSchema.Config => ({
	...(input.model === undefined ? {} : { model: { provider: input.model.provider, id: input.model.id } }),
	...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
});

/** Records a config choice; the projector merges it into the session row in the same commit. */
const choose = Effect.fn("Session.choose")(function* (sessionId: SessionSchema.ID, input: RuntimeInput) {
	const config = chosen(input);
	if (Object.keys(config).length === 0) return;
	const events = yield* Event.Service;
	yield* events.publish(EventList.ConfigChanged, { sessionId, timestamp: yield* DateTime.now, ...config });
});

const promptInput = Effect.fnUntraced(function* (input: PromptInput) {
	const value = typeof input === "string" ? { text: input } : input;
	const parts = "parts" in value ? value.parts : [{ type: "text" as const, text: value.text }];
	if (parts.length === 0)
		return yield* new PromptSchema.InvalidPromptError({ reason: "A prompt needs at least one part" });
	for (const part of parts) {
		const problem = part.type === "image" ? PromptSchema.imageProblem(part) : undefined;
		if (problem !== undefined) return yield* new PromptSchema.InvalidPromptError({ reason: problem });
	}
	return {
		prompt: PromptSchema.Prompt.make({ parts }),
		...(value.delivery === undefined ? {} : { delivery: value.delivery }),
		...(value.id === undefined ? {} : { id: value.id }),
	};
});

const makeHandle = Effect.fn("Session.makeHandle")(function* (id: SessionSchema.ID) {
	const sessions = yield* SessionStore.Service;
	const control = yield* Control.Service;
	const events = yield* Event.Service;
	const sandboxes = yield* SandboxController.Controller;

	const info = Effect.gen(function* () {
		const found = yield* sessions.get(id);
		if (Option.isNone(found)) return yield* new SessionStore.SessionNotFoundError({ sessionId: id });
		const row = found.value;
		// The env is the space's. A missing space or a destroyed env both read as
		// "no sandbox": the handle stays readable (title, directory); running it
		// is the mount's call, which refuses a removed instance.
		const space = Option.getOrUndefined(yield* sessions.space(id));
		const sandbox =
			space === undefined || space.env === SandboxInstanceSchema.ID.local
				? undefined
				: Option.getOrUndefined(yield* sandboxes.get(space.env));
		const hostDir = Option.getOrUndefined(row.hostDir);
		return {
			id,
			title: row.title,
			directory: row.directory,
			...(hostDir === undefined ? {} : { hostDir }),
			hasHostLink: hostDir !== undefined,
			...(sandbox === undefined ? {} : { sandbox }),
		};
	}).pipe(Effect.withSpan("Session.info"));

	return {
		id,
		active: control.active.pipe(Effect.map((active) => active.has(id))),
		info,
		prompt: (input) =>
			promptInput(input).pipe(Effect.flatMap((prompt) => control.prompt({ sessionId: id, ...prompt }))),
		run: (input) => promptInput(input).pipe(Effect.flatMap((prompt) => control.run({ sessionId: id, ...prompt }))),
		wait: () => control.wait(id),
		resume: () => control.resume(id),
		// The embedder API keeps its blocking contract: a caller that returns from
		// `interrupt()` can assume the drain released its mount.
		interrupt: () => control.interrupt(id, { awaitSettlement: true }),
		events: () =>
			events
				.subscribe()
				.pipe(Stream.filter((event) => (event.data as { readonly sessionId?: unknown }).sessionId === id)),
		path: () => sessions.path(id),
	} satisfies Handle;
});

export const create = Effect.fn("Session.create")(function* (input: CreateInput = {}) {
	const sessions = yield* SessionStore.Service;
	const runtime = yield* SessionRuntime.Service;
	const sandboxes = yield* SandboxController.Controller;
	const id = SessionSchema.ID.create();
	const sandboxId = input.sandbox?.id ?? SandboxInstanceSchema.ID.local;
	// Mount, then resolve the cwd into its space. The mount is
	// what makes the directory mean anything, so resolution happens inside it.
	const location = yield* sandboxes.withMount(
		sandboxId,
		Effect.provide(Location.Service.use(Effect.succeed), Location.layerMounted()),
		input.directory === undefined ? undefined : { cwd: input.directory },
	);
	yield* sessions.create({
		id,
		spaceId: location.space.id,
		directory: location.directory,
		slug: id,
		title: input.title ?? SessionSchema.DEFAULT_TITLE,
		...(input.hostDir === undefined ? {} : { hostDir: declaredHostDir(input.hostDir) }),
	});
	yield* runtime.set(id, runtimeBindings(input));
	yield* choose(id, input);
	return yield* makeHandle(id);
});

/**
 * A session's host directory, as the caller declared it.
 *
 * `resolve` here would be worse than useless. The CLI already resolves against the shell's
 * directory before it sends anything, because that is where the person is standing; every other
 * caller reaches this over RPC, where the only directory available to resolve against is the
 * *server's*. A client asking to be linked to `my-project` would be linked to
 * `<wherever the server was started>/my-project` -- a real directory on the wrong machine's
 * filesystem, branded `AbsolutePath` and persisted, with nothing anywhere reporting a problem.
 *
 * That field then selects a settings file, and that file names plugins the server imports into
 * its own process, so an invented path is not merely wrong configuration.
 *
 * Declared means declared: absolute, or the caller has not said which directory it means.
 */
const declaredHostDir = (hostDir: string): AbsolutePath =>
	AbsolutePath.make(rooted(hostDir, "a session's host directory"));

/**
 * Point an existing session at a host directory, or clear it with `null`.
 *
 * Distinct from {@link relink}, which moves the session's *work* to another space. A session can
 * move machines and keep its host project, or stay where it is and be given one it never had.
 */
export const link = Effect.fn("Session.link")(function* (input: {
	readonly sessionId: SessionSchema.ID;
	readonly hostDir: string | null;
}) {
	const sessions = yield* SessionStore.Service;
	yield* sessions.link({
		sessionId: input.sessionId,
		hostDir: input.hostDir === null ? null : declaredHostDir(input.hostDir),
	});
	return yield* makeHandle(input.sessionId);
});

/**
 * Move a session to wherever a checkout of the same project now lives — the
 * remote env died and the repo was cloned locally, say. `directory` is
 * resolved into its space exactly like `create`; the session keeps its
 * position under the new root when that absolute path exists there, else it
 * lands on the resolved directory. The transcript is untouched.
 */
export const relink = Effect.fn("Session.relink")(function* (input: RelinkInput) {
	const sessions = yield* SessionStore.Service;
	const sandboxes = yield* SandboxController.Controller;
	const sandboxId = input.sandbox?.id ?? SandboxInstanceSchema.ID.local;
	return yield* sandboxes.withMount(
		sandboxId,
		Effect.gen(function* () {
			const location = yield* Location.Service.use(Effect.succeed).pipe(Effect.provide(Location.layerMounted()));
			const session = yield* sessions.get(input.sessionId);
			const current = yield* sessions.space(input.sessionId);
			const rebased =
				Option.isSome(session) && Option.isSome(current)
					? SessionStore.rebaseDirectory(current.value.location, location.space.location, session.value.directory)
					: undefined;
			const fs = yield* SandboxIO.FileSystem;
			const directory =
				rebased !== undefined && (yield* fs.exists(rebased).pipe(Effect.orElseSucceed(() => false)))
					? rebased
					: location.directory;
			yield* sessions.relink({ sessionId: input.sessionId, spaceId: location.space.id, directory });
			return yield* makeHandle(input.sessionId);
		}),
		input.directory === undefined ? undefined : { cwd: input.directory },
	);
});

export const get = Effect.fn("Session.get")(function* (sessionId: SessionSchema.ID) {
	const sessions = yield* SessionStore.Service;
	const found = yield* sessions.get(sessionId);
	if (Option.isNone(found)) return Option.none<Handle>();
	return Option.some(yield* makeHandle(sessionId));
});

export const attach = Effect.fn("Session.attach")(function* (input: AttachInput) {
	const found = yield* get(input.sessionId);
	if (Option.isNone(found)) {
		return yield* new SessionStore.SessionNotFoundError({ sessionId: input.sessionId });
	}
	const runtime = yield* SessionRuntime.Service;
	/*
	 * Merge, not replace. `runtimeBindings` emits only the keys this call names, so a
	 * bare `attach({ sessionId })` produces `{}` -- and a replace would silently drop the
	 * tool execution mode, prompt inputs, and model a previous attach established. Bindings are now
	 * the only config layer, so there is nothing behind them to restore what a wipe took.
	 */
	yield* runtime.update(input.sessionId, runtimeBindings(input));
	yield* choose(input.sessionId, input);
	return found.value;
});

/**
 * The model and thinking level the session's next exchange runs with. A choice made through
 * {@link create} or {@link attach} is saved with the session and outlives the process; without
 * one, the session follows its settings.
 */
export const configuration = Effect.fn("Session.configuration")(function* (sessionId: SessionSchema.ID) {
	const sessions = yield* SessionStore.Service;
	if (Option.isNone(yield* sessions.get(sessionId))) {
		return yield* new SessionStore.SessionNotFoundError({ sessionId });
	}
	return yield* State.Service.use((state) => state.configuration(sessionId));
});

export { AbsolutePath, SessionMessageSchema, SessionSchema };

export * as Session from "./session.ts";
