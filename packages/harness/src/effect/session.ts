import type { Model } from "@codeworksh/aikit";
import { DateTime, Effect, Option, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import * as Control from "../control.ts";
import type { EventSchema } from "../event/schema.ts";
import * as Event from "../event/event.ts";
import { EventList } from "../event/list.ts";
import * as SandboxController from "../sandbox/control.ts";
import { SandboxInstance as SandboxInstanceSchema } from "../sandbox/instance.ts";
import { AbsolutePath } from "../schema.ts";
import { SessionMessageSchema } from "../session/message/schema.ts";
import type { Delivery } from "../session/prompt/schema.ts";
import { PromptSchema } from "../session/prompt/schema.ts";
import * as SessionRuntime from "../session/runtime.ts";
import { SessionSchema } from "../session/schema.ts";
import { Session as SessionStore } from "../session/session.ts";
import type { State } from "../state/state.ts";
import type { StatePrompt } from "../state/prompt.ts";
import type { RegisteredTool } from "../tools/tool.ts";
import type { Info as SandboxInfo } from "./sandbox.ts";
import type { bash } from "./tools.ts";

export interface ModelConfig {
	readonly provider: string;
	readonly id: string;
	readonly options?: State.RequestOptions;
}

export interface ToolsConfig {
	readonly builtins?: ReadonlyArray<typeof bash>;
	readonly extras?: ReadonlyArray<RegisteredTool>;
	readonly execution?: State.ToolExecutionMode;
}

export interface SystemPromptConfig {
	readonly custom?: string;
	readonly append?: string;
	readonly override?: StatePrompt.PromptSystemOverride;
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
}

export interface AttachInput extends RuntimeInput {
	readonly sessionId: SessionSchema.ID;
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
	readonly sandbox?: SandboxInfo;
}

export interface Handle {
	readonly id: SessionSchema.ID;
	readonly active: Effect.Effect<boolean>;
	readonly info: Effect.Effect<Info, SessionStore.SessionNotFoundError>;
	readonly prompt: (input: PromptInput) => ReturnType<Control.Interface["prompt"]>;
	readonly run: (input: PromptInput) => ReturnType<Control.Interface["run"]>;
	readonly resume: () => ReturnType<Control.Interface["resume"]>;
	readonly interrupt: () => ReturnType<Control.Interface["interrupt"]>;
	readonly events: (options?: { readonly after?: number }) => Stream.Stream<EventSchema.Payload>;
	readonly path: () => Effect.Effect<ReadonlyArray<SessionStore.HydratedEntry>>;
}

const runtimeBindings = (input: RuntimeInput): SessionRuntime.Bindings => ({
	...input.model?.options,
	...(input.model === undefined ? {} : { provider: input.model.provider, model: input.model.id }),
	...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
	...(input.tools?.extras === undefined ? {} : { tools: input.tools.extras }),
	...(input.tools?.builtins === undefined ? {} : { builtinTools: input.tools.builtins }),
	...(input.tools?.execution === undefined ? {} : { toolExecution: input.tools.execution }),
	...(input.systemPrompt?.custom === undefined ? {} : { promptCustom: input.systemPrompt.custom }),
	...(input.systemPrompt?.append === undefined ? {} : { promptSystemAppend: input.systemPrompt.append }),
	...(input.systemPrompt?.override === undefined ? {} : { promptSystemOverride: input.systemPrompt.override }),
});

const publishConfig = Effect.fn("Session.publishConfig")(function* (
	events: Event.Interface,
	sessionId: SessionSchema.ID,
	input: Pick<RuntimeInput, "model" | "thinkingLevel">,
) {
	if (input.model === undefined && input.thinkingLevel === undefined) return;
	yield* events.publish(EventList.ConfigChanged, {
		timestamp: yield* DateTime.now,
		sessionId,
		...(input.model === undefined ? {} : { model: { providerId: input.model.provider, modelId: input.model.id } }),
		...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
	});
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
		const sandboxId = SandboxInstanceSchema.fromField(row.sandboxInstanceId);
		const sandbox =
			sandboxId === SandboxInstanceSchema.ID.local
				? undefined
				: Option.getOrUndefined(yield* sandboxes.get(sandboxId));
		return {
			id,
			title: row.title,
			directory: AbsolutePath.make(row.directory),
			...(sandbox === undefined ? {} : { sandbox }),
		};
	}).pipe(Effect.withSpan("Session.info"));

	return {
		id,
		active: control.active.pipe(Effect.map((active) => active.has(id))),
		info,
		prompt: (input) => control.prompt({ sessionId: id, ...promptInput(input) }),
		run: (input) => control.run({ sessionId: id, ...promptInput(input) }),
		resume: () => control.resume(id),
		interrupt: () => control.interrupt(id),
		events: (options = {}) => events.stream({ sessionId: id, ...options }),
		path: () => sessions.path(id),
	} satisfies Handle;
});

const ensureLocalProject = Effect.fn("Session.ensureLocalProject")(function* () {
	const sql = yield* SqlClient.SqlClient;
	const now = DateTime.toEpochMillis(yield* DateTime.now);
	yield* sql`
		INSERT INTO project (id, name, created_at, updated_at)
		VALUES ('local', 'local', ${now}, ${now})
		ON CONFLICT(id) DO NOTHING
	`.pipe(Effect.orDie);
});

export const create = Effect.fn("Session.create")(function* (input: CreateInput = {}) {
	const sessions = yield* SessionStore.Service;
	const runtime = yield* SessionRuntime.Service;
	const sandboxes = yield* SandboxController.Controller;
	const events = yield* Event.Service;
	const id = SessionSchema.ID.create();
	const sandboxId = input.sandbox?.id ?? SandboxInstanceSchema.ID.local;
	const directory = yield* sandboxes.resolveCwd(sandboxId, input.directory);
	yield* ensureLocalProject();
	yield* sessions.create({
		id,
		projectId: "local",
		slug: id,
		title: input.title ?? "Session",
		directory: AbsolutePath.make(directory),
		sandboxInstanceId: sandboxId,
	});
	yield* publishConfig(events, id, input);
	yield* runtime.set(id, runtimeBindings(input));
	return yield* makeHandle(id);
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
	const events = yield* Event.Service;
	yield* publishConfig(events, input.sessionId, input);
	yield* runtime.set(input.sessionId, runtimeBindings(input));
	return found.value;
});

export { AbsolutePath, SessionMessageSchema, SessionSchema };

export * as Session from "./session.ts";
