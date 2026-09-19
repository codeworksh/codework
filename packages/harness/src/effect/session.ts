import type { Model } from "@codeworksh/aikit";
import { Effect, Option, Stream } from "effect";
import * as Control from "../control.ts";
import * as Event from "../event/event.ts";
import type { EventSchema } from "../event/schema.ts";
import { hostPath } from "../host.ts";
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
import type { State } from "../state/state.ts";
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
	 * The host directory this session belongs to: where its settings and its project plugins are
	 * discovered from. A host path on the machine the harness runs on, unrelated to
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

export type PromptInput =
	| string
	| {
			readonly text: string;
			readonly delivery?: Delivery;
			readonly id?: SessionMessageSchema.ID;
	  };

export interface Info {
	readonly id: SessionSchema.ID;
	readonly title: string;
	readonly directory: AbsolutePath;
	/** Absent when the session has no host project; see {@link CreateInput.hostDir}. */
	readonly hostDir?: AbsolutePath;
	/**
	 * Whether this session has a host project at all.
	 *
	 * Not new state -- it is `hostDir !== undefined` -- but it is the question callers actually
	 * ask, and asking it by name keeps "has a project" from being spelled four different ways at
	 * four call sites. It is deliberately absent from the wire contract, where `hostDir` is right
	 * there and a second derived field could only ever disagree with it.
	 */
	readonly hasHostLink: boolean;
	readonly sandbox?: SandboxInfo;
}

export interface Handle {
	readonly id: SessionSchema.ID;
	readonly active: Effect.Effect<boolean>;
	readonly info: Effect.Effect<Info, SessionStore.SessionNotFoundError>;
	readonly prompt: (input: PromptInput) => ReturnType<Control.Interface["prompt"]>;
	readonly run: (input: PromptInput) => ReturnType<Control.Interface["run"]>;
	readonly wait: () => ReturnType<Control.Interface["wait"]>;
	readonly resume: () => ReturnType<Control.Interface["resume"]>;
	/** Stops active work and waits for its cleanup; idle is a no-op returning false. */
	readonly interrupt: () => ReturnType<Control.Interface["interrupt"]>;
	/** Live session notifications. Use Event.log for durable replay. */
	readonly events: () => Stream.Stream<EventSchema.Payload, Event.SubscriptionOverflowError>;
	readonly path: () => Effect.Effect<ReadonlyArray<SessionStore.HydratedEntry>>;
}

const runtimeBindings = (input: RuntimeInput): SessionRuntime.Bindings => ({
	...input.model?.options,
	...(input.model === undefined ? {} : { provider: input.model.provider, model: input.model.id }),
	...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
	...(input.tools?.execution === undefined ? {} : { toolExecution: input.tools.execution }),
	...(input.systemPrompt?.custom === undefined ? {} : { promptCustom: input.systemPrompt.custom }),
	...(input.systemPrompt?.append === undefined ? {} : { promptSystemAppend: input.systemPrompt.append }),
});

const promptInput = (input: PromptInput) => {
	const value = typeof input === "string" ? { text: input } : input;
	return {
		prompt: PromptSchema.Prompt.make({ text: value.text }),
		...(value.delivery === undefined ? {} : { delivery: value.delivery }),
		...(value.id === undefined ? {} : { id: value.id }),
	};
};

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
		prompt: (input) => control.prompt({ sessionId: id, ...promptInput(input) }),
		run: (input) => control.run({ sessionId: id, ...promptInput(input) }),
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
		title: input.title ?? "Session",
		...(input.hostDir === undefined ? {} : { hostDir: AbsolutePath.make(hostPath.resolve(input.hostDir)) }),
	});
	yield* runtime.set(id, runtimeBindings(input));
	return yield* makeHandle(id);
});

/**
 * Point an existing session at a host directory, or clear it with `null`.
 *
 * The settings and plugin layers it reads change at the next exchange, because every exchange
 * discovers from the session's current value rather than from one captured at creation.
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
		hostDir: input.hostDir === null ? null : AbsolutePath.make(hostPath.resolve(input.hostDir)),
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
	return found.value;
});

export { AbsolutePath, SessionMessageSchema, SessionSchema };

export * as Session from "./session.ts";
