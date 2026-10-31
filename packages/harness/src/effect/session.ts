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
import type { ProjectSchema } from "../project/schema.ts";
import { AbsolutePath } from "../schema.ts";
import { SessionMessageSchema } from "../session/message/schema.ts";
import type { Delivery } from "../session/prompt/schema.ts";
import { PromptSchema } from "../session/prompt/schema.ts";
import * as SessionRuntime from "../session/runtime.ts";
import type { ThreadRow } from "../db/schema.sql.ts";
import { Document } from "../document/document.ts";
import { DocumentSchema } from "../document/schema.ts";
import { SessionSchema } from "../session/schema.ts";
import { Session as SessionStore } from "../session/session.ts";
import { ThreadSchema } from "../thread/schema.ts";
import { Thread } from "../thread/thread.ts";
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
	/** The thread's own prompt foundation, in place of the rendered one; `null` goes back to it. */
	readonly foundation?: string | null;
	readonly tools?: ToolsConfig;
	readonly systemPrompt?: SystemPromptConfig;
}

export interface CreateInput extends RuntimeInput {
	/** The main thread's title; absent = its first prompt names it. */
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
	/** Names the session's project if this creates it; an existing project keeps its name. */
	readonly project?: { readonly name: string };
}

export interface AttachInput extends RuntimeInput {
	readonly sessionId: SessionSchema.ID;
	/** Absent = the session's `main` thread. */
	readonly threadId?: ThreadSchema.ID;
}

export interface RelinkInput {
	readonly sessionId: SessionSchema.ID;
	/** Absent moves the session's default; present sets that thread's placement. */
	readonly threadId?: ThreadSchema.ID;
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
	readonly directory: AbsolutePath;
	/** Absent when the session has no host anchor; see {@link CreateInput.hostDir}. */
	readonly hostDir?: AbsolutePath;
	/** Whether this session has a host anchor at all. */
	readonly hasHostLink: boolean;
	readonly sandbox?: SandboxInfo;
	/** Absent only when the session's space or project row is missing. */
	readonly project?: { readonly id: ProjectSchema.ID; readonly name: string };
	/** Last activity in any of its threads, epoch milliseconds. */
	readonly updatedAt: number;
	readonly mainThreadId: ThreadSchema.ID;
}

export interface ThreadInfo {
	readonly id: ThreadSchema.ID;
	readonly sessionId: SessionSchema.ID;
	readonly origin: ThreadSchema.Origin;
	/** Absent until its first own prompt; clients show a fork's source title until then. */
	readonly title?: string;
	/** Last activity, epoch milliseconds: every appended entry moves it. */
	readonly updatedAt: number;
	/** The model chosen for this thread over settings; absent when settings decide. */
	readonly model?: { readonly provider: string; readonly id: string };
	/** The thinking level chosen for this thread over settings; absent when settings decide. */
	readonly thinkingLevel?: Model.ThinkingLevel;
	/** The prompt foundation chosen for this thread; absent when prompt plugins render it. */
	readonly foundation?: string;
	/** Where it runs instead of the session's space and directory. */
	readonly placement?: DocumentSchema.Placement;
	/**
	 * Its unfinished run was cut off {@link Control.RESTART_LIMIT} times, so the server no longer
	 * resumes it; the next prompt runs it again.
	 */
	readonly parked: boolean;
	/** Billed usage of its own entries; what it inherits through a fork point counts for its source. */
	readonly usage: Usage;
	readonly session: Info;
}

export interface Usage {
	readonly cost: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface ForkInput {
	readonly entryId: string;
	readonly mode?: "at" | "before";
}

export interface ThreadHandle {
	readonly id: ThreadSchema.ID;
	readonly sessionId: SessionSchema.ID;
	readonly active: Effect.Effect<boolean>;
	readonly info: Effect.Effect<ThreadInfo, SessionStore.SessionNotFoundError | Thread.ThreadNotFoundError>;
	readonly prompt: (input: PromptInput) => PromptResult;
	readonly run: (input: PromptInput) => PromptResult;
	readonly wait: () => ReturnType<Control.Interface["wait"]>;
	readonly resume: () => ReturnType<Control.Interface["resume"]>;
	/** Stops active work and waits for its cleanup; idle is a no-op returning false. */
	readonly interrupt: () => ReturnType<Control.Interface["interrupt"]>;
	/** Records model, thinking and foundation choices in the thread's `agent` document. */
	readonly configure: (input: RuntimeInput) => Effect.Effect<void>;
	/** A new thread cut at a committed entry of this one's line; `text` refills the editor for `before`. */
	readonly fork: (
		input: ForkInput,
	) => Effect.Effect<
		{ readonly thread: ThreadHandle; readonly text?: string },
		Thread.ThreadNotFoundError | Thread.ForkError
	>;
	/** Live notifications of this thread. Use Event.log for durable replay. */
	readonly events: () => Stream.Stream<EventSchema.Payload, Event.SubscriptionOverflowError>;
	/** The thread's line: inherited entries through the fork point, then its own. */
	readonly history: () => Effect.Effect<ReadonlyArray<Thread.HydratedEntry>>;
}

export interface Handle {
	readonly id: SessionSchema.ID;
	readonly info: Effect.Effect<Info, SessionStore.SessionNotFoundError>;
	/** The session's `main` thread, where unaddressed prompts go. */
	readonly main: ThreadHandle;
	/** One of the session's threads; `main` names the main one. */
	readonly thread: (
		id: ThreadSchema.ID | typeof ThreadSchema.MAIN,
	) => Effect.Effect<ThreadHandle, Thread.ThreadNotFoundError>;
	readonly threads: Effect.Effect<ReadonlyArray<ThreadHandle>>;
	/** Stops every running thread and waits for their cleanup; false when none was running. */
	readonly interrupt: () => Effect.Effect<boolean>;
}

/** What stays in this process. The model and thinking level are the thread's {@link chosen} `agent`. */
const runtimeBindings = (input: RuntimeInput): SessionRuntime.Bindings => ({
	...input.model?.options,
	...(input.tools?.execution === undefined ? {} : { toolExecution: input.tools.execution }),
	...(input.systemPrompt?.custom === undefined ? {} : { promptCustom: input.systemPrompt.custom }),
	...(input.systemPrompt?.append === undefined ? {} : { promptSystemAppend: input.systemPrompt.append }),
});

/** The `agent` fields this input names. */
const chosen = (input: RuntimeInput): DocumentSchema.AgentChange => ({
	...(input.model === undefined ? {} : { model: { provider: input.model.provider, id: input.model.id } }),
	...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
	...(input.foundation === undefined ? {} : { foundation: input.foundation }),
});

/** Records a choice as one `agent` revision; nothing when the input names none. */
const choose = Effect.fn("Session.choose")(function* (
	sessionId: SessionSchema.ID,
	threadId: ThreadSchema.ID,
	input: RuntimeInput,
) {
	const change = chosen(input);
	if (Object.keys(change).length === 0) return;
	const events = yield* Event.Service;
	yield* events.publish(EventList.ThreadConfigured, { sessionId, threadId, timestamp: yield* DateTime.now, change });
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

export const info = Effect.fn("Session.info")(function* (id: SessionSchema.ID) {
	const sessions = yield* SessionStore.Service;
	const threads = yield* Thread.Service;
	const sandboxes = yield* SandboxController.Controller;
	const found = yield* sessions.get(id);
	const main = yield* threads.main(id);
	if (Option.isNone(found) || Option.isNone(main))
		return yield* new SessionStore.SessionNotFoundError({ sessionId: id });
	const row = found.value;
	// The env is the space's. A missing space or a destroyed env both read as
	// "no sandbox": the handle stays readable; running it is the mount's call,
	// which refuses a removed instance.
	const space = Option.getOrUndefined(yield* sessions.space(id));
	const sandbox =
		space === undefined || space.env === SandboxInstanceSchema.ID.local
			? undefined
			: Option.getOrUndefined(yield* sandboxes.get(space.env));
	const hostDir = Option.getOrUndefined(row.hostDir);
	const project = Option.getOrUndefined(yield* sessions.project(id));
	return {
		id,
		directory: row.directory,
		...(hostDir === undefined ? {} : { hostDir }),
		hasHostLink: hostDir !== undefined,
		...(sandbox === undefined ? {} : { sandbox }),
		...(project === undefined ? {} : { project: { id: project.id, name: project.name } }),
		updatedAt: DateTime.toEpochMillis(row.updatedAt),
		mainThreadId: ThreadSchema.ID.make(main.value.id),
	} satisfies Info;
});

const originOf = (row: ThreadRow): ThreadSchema.Origin => {
	const threadId = Option.getOrUndefined(row.originThreadId);
	const entryId = Option.getOrUndefined(row.originEntryId);
	const callId = Option.getOrUndefined(row.originCallId);
	if (row.originKind === "fork" && threadId !== undefined && entryId !== undefined)
		return { kind: "fork", threadId, entryId };
	if (row.originKind === "subagent" && threadId !== undefined && callId !== undefined)
		return { kind: "subagent", threadId, callId, ...(entryId === undefined ? {} : { entryId }) };
	return { kind: "main" };
};

export const threadInfo = Effect.fn("Session.threadInfo")(function* (id: ThreadSchema.ID) {
	const threads = yield* Thread.Service;
	const documents = yield* Document.Service;
	const control = yield* Control.Service;
	const found = yield* threads.get(id);
	if (Option.isNone(found)) return yield* new Thread.ThreadNotFoundError({ threadId: id });
	const row = found.value;
	const agent = yield* documents.agent(id);
	const title = Option.getOrUndefined(row.title);
	const parked =
		Option.isSome(row.execution) && row.restarts >= Control.RESTART_LIMIT && !(yield* control.active).has(id);
	return {
		id,
		sessionId: SessionSchema.ID.make(row.sessionId),
		origin: originOf(row),
		...(title === undefined ? {} : { title }),
		updatedAt: DateTime.toEpochMillis(row.updatedAt),
		...(agent.model === undefined ? {} : { model: agent.model }),
		...(agent.thinkingLevel === undefined ? {} : { thinkingLevel: agent.thinkingLevel }),
		...(agent.foundation === undefined ? {} : { foundation: agent.foundation }),
		...(agent.placement === undefined ? {} : { placement: agent.placement }),
		parked,
		usage: {
			cost: row.cost,
			input: row.tokensInput,
			output: row.tokensOutput,
			cacheRead: row.tokensCacheRead,
			cacheWrite: row.tokensCacheWrite,
		},
		session: yield* info(SessionSchema.ID.make(row.sessionId)),
	} satisfies ThreadInfo;
});

const makeThread = Effect.fn("Session.makeThread")(function* (sessionId: SessionSchema.ID, id: ThreadSchema.ID) {
	const context = yield* Effect.context<
		| SessionStore.Service
		| Thread.Service
		| Document.Service
		| Control.Service
		| Event.Service
		| SandboxController.Controller
	>();
	const threads = yield* Thread.Service;
	const control = yield* Control.Service;
	const events = yield* Event.Service;
	const handle: ThreadHandle = {
		id,
		sessionId,
		active: control.active.pipe(Effect.map((active) => active.has(id))),
		info: threadInfo(id).pipe(Effect.provideContext(context)),
		prompt: (input) =>
			promptInput(input).pipe(Effect.flatMap((prompt) => control.prompt({ sessionId, threadId: id, ...prompt }))),
		run: (input) =>
			promptInput(input).pipe(Effect.flatMap((prompt) => control.run({ sessionId, threadId: id, ...prompt }))),
		wait: () => control.wait(id),
		resume: () => control.resume(id),
		// The embedder API keeps its blocking contract: a caller that returns from
		// `interrupt()` can assume the drain released its mount.
		interrupt: () => control.interrupt(id, { awaitSettlement: true }),
		configure: (input) => choose(sessionId, id, input).pipe(Effect.provideContext(context)),
		fork: (input) =>
			threads.fork({ threadId: id, ...input }).pipe(
				Effect.flatMap((forked) =>
					makeThread(sessionId, ThreadSchema.ID.make(forked.thread.id)).pipe(
						Effect.provideContext(context),
						Effect.map((thread) => ({ thread, ...(forked.text === undefined ? {} : { text: forked.text }) })),
					),
				),
			),
		events: () =>
			events
				.subscribe()
				.pipe(Stream.filter((event) => (event.data as { readonly threadId?: unknown }).threadId === id)),
		history: () => threads.line(id),
	};
	return handle;
});

const makeHandle = Effect.fn("Session.makeHandle")(function* (id: SessionSchema.ID) {
	const context = yield* Effect.context<
		| SessionStore.Service
		| Thread.Service
		| Document.Service
		| Control.Service
		| Event.Service
		| SandboxController.Controller
	>();
	const threads = yield* Thread.Service;
	const control = yield* Control.Service;
	const main = yield* threads.main(id);
	if (Option.isNone(main)) return yield* new SessionStore.SessionNotFoundError({ sessionId: id });
	const mainHandle = yield* makeThread(id, ThreadSchema.ID.make(main.value.id));
	return {
		id,
		info: info(id).pipe(Effect.provideContext(context)),
		main: mainHandle,
		thread: (threadId) =>
			Effect.gen(function* () {
				if (threadId === ThreadSchema.MAIN) return mainHandle;
				const found = yield* threads.get(threadId);
				if (Option.isNone(found) || found.value.sessionId !== id) {
					return yield* new Thread.ThreadNotFoundError({ threadId });
				}
				return yield* makeThread(id, threadId);
			}).pipe(Effect.provideContext(context)),
		threads: threads.list(id).pipe(
			Effect.flatMap((rows) => Effect.forEach(rows, (row) => makeThread(id, ThreadSchema.ID.make(row.id)))),
			Effect.provideContext(context),
		),
		interrupt: () => control.interruptSession(id, { awaitSettlement: true }),
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
		Effect.provide(
			Location.Service.use(Effect.succeed),
			Location.layerMounted(input.project === undefined ? undefined : { name: input.project.name }),
		),
		input.directory === undefined ? undefined : { cwd: input.directory },
	);
	yield* sessions.create({
		id,
		spaceId: location.space.id,
		directory: location.directory,
		...(input.title === undefined ? {} : { title: input.title }),
		...(input.hostDir === undefined ? {} : { hostDir: declaredHostDir(input.hostDir) }),
		agent: DocumentSchema.applyAgentChange({}, chosen(input)),
	});
	yield* runtime.set(id, runtimeBindings(input));
	return yield* makeHandle(id).pipe(Effect.orDie);
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
 *
 * With `threadId`, only that thread moves: its `agent.placement` is set, and the session's
 * default, which every other thread follows, stays.
 */
export const relink = Effect.fn("Session.relink")(function* (input: RelinkInput) {
	const sessions = yield* SessionStore.Service;
	const sandboxes = yield* SandboxController.Controller;
	const sandboxId = input.sandbox?.id ?? SandboxInstanceSchema.ID.local;
	return yield* sandboxes.withMount(
		sandboxId,
		Effect.gen(function* () {
			const location = yield* Location.Service.use(Effect.succeed).pipe(Effect.provide(Location.layerMounted()));
			const rebased = yield* sessions.rebase({
				sessionId: input.sessionId,
				...(input.threadId === undefined ? {} : { threadId: input.threadId }),
				to: location.space.location,
			});
			const fs = yield* SandboxIO.FileSystem;
			const directory =
				Option.isSome(rebased) && (yield* fs.exists(rebased.value).pipe(Effect.orElseSucceed(() => false)))
					? rebased.value
					: location.directory;
			yield* sessions.relink({
				sessionId: input.sessionId,
				...(input.threadId === undefined ? {} : { threadId: input.threadId }),
				spaceId: location.space.id,
				directory,
			});
			return yield* makeHandle(input.sessionId);
		}),
		input.directory === undefined ? undefined : { cwd: input.directory },
	);
});

export const get = Effect.fn("Session.get")(function* (sessionId: SessionSchema.ID) {
	const sessions = yield* SessionStore.Service;
	const found = yield* sessions.get(sessionId);
	if (Option.isNone(found)) return Option.none<Handle>();
	return Option.some(yield* makeHandle(sessionId).pipe(Effect.orDie));
});

/**
 * A thread of an existing session (its `main` when `threadId` is absent), with this process's
 * bindings merged in and any model or thinking choice recorded in its `agent` document.
 */
export const attach = Effect.fn("Session.attach")(function* (input: AttachInput) {
	const found = yield* get(input.sessionId);
	if (Option.isNone(found)) {
		return yield* new SessionStore.SessionNotFoundError({ sessionId: input.sessionId });
	}
	const thread = yield* found.value.thread(input.threadId ?? ThreadSchema.MAIN);
	const runtime = yield* SessionRuntime.Service;
	/*
	 * Merge, not replace. `runtimeBindings` emits only the keys this call names, so a
	 * bare `attach({ sessionId })` produces `{}` -- and a replace would silently drop the
	 * tool execution mode, prompt inputs, and model a previous attach established.
	 */
	yield* runtime.update(input.sessionId, runtimeBindings(input));
	yield* choose(input.sessionId, thread.id, input);
	return thread;
});

/** Removes a session after stopping its threads. False when it did not exist. */
export const remove = Effect.fn("Session.delete")(function* (sessionId: SessionSchema.ID) {
	const control = yield* Control.Service;
	const runtime = yield* SessionRuntime.Service;
	const deleted = yield* control.deleteSession(sessionId);
	yield* runtime.remove(sessionId);
	return deleted;
});

/**
 * The model and thinking level a thread's next turn runs with. A choice made through
 * {@link create}, {@link attach} or `configure` is saved with the thread and outlives the
 * process; without one, the thread follows its settings.
 */
export const configuration = Effect.fn("Session.configuration")(function* (threadId: ThreadSchema.ID) {
	const threads = yield* Thread.Service;
	if (Option.isNone(yield* threads.get(threadId))) {
		return yield* new Thread.ThreadNotFoundError({ threadId });
	}
	return yield* State.Service.use((state) => state.configuration(threadId));
});

export { AbsolutePath, SessionMessageSchema, SessionSchema, ThreadSchema };

export * as Session from "./session.ts";
