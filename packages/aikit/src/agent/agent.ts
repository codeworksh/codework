import { NamedError } from "@codeworksh/utils";
import Type, { type Static, type TSchema } from "typebox";
import type { Event } from "../event/event";
import { Message } from "../message/message";
import { Model } from "../model/model";
import type { Provider } from "../provider/provider";
import "../provider/register";
import { Stream } from "../provider/stream";
import { Loop } from "./loop";

export namespace Agent {
	export const ToolTerminalResultSchema = Type.Union([Message.ToolCompletedSchema, Message.ToolErrorSchema]);
	export const ToolResultSchema = Type.Union([
		Message.ToolRunningSchema,
		Message.ToolCompletedSchema,
		Message.ToolErrorSchema,
	]);

	export type ToolRunningResult<T> = Omit<Static<typeof Message.ToolRunningSchema>, "partial"> & {
		partial?: Omit<Static<typeof Message.ToolRunningPartial>, "details"> & {
			details?: T;
		};
	};
	export type ToolCompletedResult<T> = Omit<Static<typeof Message.ToolCompletedSchema>, "result"> & {
		result: Omit<Static<typeof Message.ToolSuccessResult>, "details"> & {
			details?: T;
		};
	};
	export type ToolErrorResult<T> = Omit<Static<typeof Message.ToolErrorSchema>, "result"> & {
		result: Omit<Static<typeof Message.ToolErrorResult>, "details"> & {
			details?: T;
		};
	};
	export type ToolTerminalResult<TCompleted = unknown, TError = unknown> =
		| ToolCompletedResult<TCompleted>
		| ToolErrorResult<TError>;
	type InferSchema<T extends TSchema | undefined> = T extends TSchema ? Static<T> : unknown;

	// callback for tool execution updates.
	// consumers can narrow on status if needed
	// type inference:
	// U - update
	export type ToolUpdateCallback<U = unknown> = (result: ToolRunningResult<U>) => Promise<void> | void;

	export interface AgentTool<
		TParameters extends TSchema = TSchema,
		TOutput extends TSchema | undefined = undefined,
		TUpdate = unknown,
		TError extends TSchema | undefined = undefined,
	> extends Message.Tool<TParameters> {
		// A human-readable label for the tool for display
		label: string;
		outputSchema?: TOutput;
		errorSchema?: TError;
		execute: (
			callID: string,
			params: Static<TParameters>,
			signal?: AbortSignal,
			onUpdate?: ToolUpdateCallback<TUpdate>,
		) => Promise<ToolTerminalResult<InferSchema<TOutput>, InferSchema<TError>>>;
	}

	export function defineTool<
		TParameters extends TSchema,
		TOutput extends TSchema | undefined = undefined,
		TUpdate = unknown,
		TError extends TSchema | undefined = undefined,
	>(tool: AgentTool<TParameters, TOutput, TUpdate, TError>): AgentTool<TParameters, TOutput, TUpdate, TError> {
		return tool;
	}

	export type AnyAgentTool = AgentTool<any, any, any, any>;

	export interface State {
		name: string;
		systemPrompt: string;
		model: Model.Info;
		thinkingLevel: Stream.ThinkingLevel;
		tools: AnyAgentTool[];
		messages: Message.Message[];
		isStreaming: boolean;
		streamMessage: Message.Message | null;
		pendingToolCalls: Set<string>;
		error?: string;
	}

	// AgentContext is like Message.Context but uses AgentTool
	// TODO: @sanchitrk: rename this to Context; Agent.Context
	export interface AgentContext {
		systemPrompt: string;
		messages: Message.Message[];
		tools?: AnyAgentTool[];
	}

	export const ToolCallInFlightSchema = Type.Object({
		callID: Type.String(),
		name: Type.String(),
		rawArgs: Type.Record(Type.String(), Type.Unknown()),
		args: Type.Optional(Type.Unknown()), // post validation
	});
	export type ToolCallInFlight = Static<typeof ToolCallInFlightSchema>;

	export const ModelNotFoundErr = NamedError.create(
		"ModelNotFoundErr",
		Type.Object({
			message: Type.String(),
			provider: Type.String(),
			model: Type.String(),
		}),
	);

	export const ModelNotConfiguredErr = NamedError.create(
		"ModelNotConfiguredErr",
		Type.Object({
			message: Type.String(),
		}),
	);

	export interface AgentOptions {
		initialState?: Partial<State>;
		convertToLlm?: (messages: Message.Message[]) => Message.Message[] | Promise<Message.Message[]>;
		/**
		 * Optional transform applied to the context before `convertToLlm`.
		 *
		 * Use this for operations that work at the AgentMessage level:
		 * - Context window management (pruning old messages)
		 * - Injecting context from external sources
		 *
		 * @example
		 * ```typescript
		 * transformContext: async (messages) => {
		 *   if (estimateTokens(messages) > MAX_TOKENS) {
		 *     return pruneOldMessages(messages);
		 *   }
		 *   return messages;
		 * }
		 * ```
		 */
		transformContext?: (messages: Message.Message[], signal?: AbortSignal) => Promise<Message.Message[]>;
		/**
		 * Steering mode: "all" = send all steering messages at once, "one-at-a-time" = one per turn
		 */
		steeringMode?: "all" | "one-at-a-time";

		/**
		 * Follow-up mode: "all" = send all follow-up messages at once, "one-at-a-time" = one per turn
		 */
		followUpMode?: "all" | "one-at-a-time";
		/**
		 * Custom stream function (for proxy backends, etc.). Default uses streamSimple.
		 */
		streamFn?: Loop.StreamFn;
		/**
		 * Optional session identifier forwarded to LLM providers.
		 * Used by providers that support session-based caching (e.g., OpenAI Codex).
		 */
		sessionId?: string;
		/**
		 * Resolves an API key dynamically for each LLM call.
		 * Useful for expiring tokens (e.g., GitHub Copilot OAuth).
		 */
		getApiKey?: (provider: Provider.Info) => Promise<string | undefined> | string | undefined;
		/**
		 * Inspect or replace provider payloads before they are sent.
		 */
		onPayload?: Stream.SimpleOptions["onPayload"];
		/**
		 * Custom token budgets for thinking levels (token-based providers only).
		 */
		thinkingBudgets?: Stream.ThinkingBudgets;
		/**
		 * Preferred transport for providers that support multiple transports.
		 */
		transport?: Stream.Transport;
		/**
		 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
		 * If the server's requested delay exceeds this value, the request fails immediately,
		 * allowing higher-level retry logic to handle it with user visibility.
		 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
		 */
		maxRetryDelayMs?: number;
		/** Tool execution mode. Default: "parallel" */
		toolExecution?: Loop.ToolExecutionMode;
		/** Called before a tool is executed, after arguments have been validated. */
		beforeToolExecution?: (
			context: Loop.BeforeToolExecutionContext,
			signal?: AbortSignal,
		) => Promise<Loop.BeforeToolCallResult | undefined>;
		/** Called after a tool finishes executing, before final tool events are emitted. */
		afterToolExecution?: (
			context: Loop.AfterToolExecutionContext,
			signal?: AbortSignal,
		) => Promise<Agent.ToolTerminalResult<unknown> | undefined>;
	}

	export const AgentInStreamingErr = NamedError.create(
		"AgentInStreamingErr",
		Type.Object({
			message: Type.String(),
			name: Type.String(),
		}),
	);

	export class Instance {
		private _state: State;

		private listeners = new Set<(e: Event.AgentEvent) => void>();
		private abortController?: AbortController;

		private convertToLlm: (messages: Message.Message[]) => Message.Message[] | Promise<Message.Message[]>;
		private transformContext?: (messages: Message.Message[], signal?: AbortSignal) => Promise<Message.Message[]>;

		private steeringQueue: Message.UserMessage[] = [];
		private followUpQueue: Message.UserMessage[] = [];
		private steeringMode: "all" | "one-at-a-time";
		private followUpMode: "all" | "one-at-a-time";

		public streamFn: Loop.StreamFn;

		private _sessionId?: string;
		public getApiKey?: (provider: Provider.Info) => Promise<string | undefined> | string | undefined;

		private _onPayload?: Stream.SimpleOptions["onPayload"];

		private runningPrompt?: Promise<void>;
		private resolveRunningPrompt?: () => void;
		private _thinkingBudgets?: Stream.ThinkingBudgets;
		private _transport: Stream.Transport;
		private _maxRetryDelayMs?: number;
		private _toolExecution: Loop.ToolExecutionMode;

		private _beforeToolExecution?: (
			context: Loop.BeforeToolExecutionContext,
			signal?: AbortSignal,
		) => Promise<Loop.BeforeToolCallResult | undefined>;
		private _afterToolExecution?: (
			context: Loop.AfterToolExecutionContext,
			signal?: AbortSignal,
		) => Promise<Agent.ToolTerminalResult<unknown> | undefined>;

		constructor(name: string, model: Model.Info, opts: AgentOptions = {}) {
			this._state = {
				systemPrompt: "",
				thinkingLevel: "off",
				tools: [],
				messages: [],
				isStreaming: false,
				streamMessage: null,
				pendingToolCalls: new Set<string>(),
				error: undefined,
				...opts.initialState,
				name,
				model,
			};
			/**
			 * Transformation logic to prepare messages for the LLM.
			 * * @remarks
			 * Currently just forwards messages as-is. Modify this logic when
			 * specific formatting or filtering is required.
			 * A good example is using user message parts with custom content
			 * * @default
			 * forwards messages as is.
			 */
			this.convertToLlm = opts.convertToLlm || ((messages: Message.Message[]) => messages);
			this.transformContext = opts.transformContext;

			this.steeringMode = opts.steeringMode || "one-at-a-time";
			this.followUpMode = opts.followUpMode || "one-at-a-time";

			this.streamFn = opts.streamFn || Stream.streamSimple;
			this._sessionId = opts.sessionId;

			this.getApiKey = opts.getApiKey;
			this._onPayload = opts.onPayload;

			this._thinkingBudgets = opts.thinkingBudgets;
			this._transport = opts.transport ?? "sse";
			this._maxRetryDelayMs = opts.maxRetryDelayMs;

			this._toolExecution = opts.toolExecution ?? "parallel";
			this._beforeToolExecution = opts.beforeToolExecution;
			this._afterToolExecution = opts.afterToolExecution;
		}

		/**
		 * Get the current session ID used for provider caching.
		 */
		get sessionId(): string | undefined {
			return this._sessionId;
		}

		/**
		 * Set the session ID for provider caching.
		 * Call this when switching sessions (new session, branch, resume, etc).
		 */
		set sessionId(value: string | undefined) {
			this._sessionId = value;
		}
		/**
		 * Get the current thinking budgets.
		 */
		get thinkingBudgets(): Stream.ThinkingBudgets | undefined {
			return this._thinkingBudgets;
		}
		/**
		 * Set custom thinking budgets for token-based providers.
		 */
		set thinkingBudgets(value: Stream.ThinkingBudgets | undefined) {
			this._thinkingBudgets = value;
		}

		/**
		 * Get the current preferred transport.
		 */
		get transport(): Stream.Transport {
			return this._transport;
		}
		/**
		 * Set the preferred transport.
		 */
		setTransport(value: Stream.Transport) {
			this._transport = value;
		}

		/**
		 * Get the current max retry delay in milliseconds.
		 */
		get maxRetryDelayMs(): number | undefined {
			return this._maxRetryDelayMs;
		}

		/**
		 * Set the maximum delay to wait for server-requested retries.
		 * Set to 0 to disable the cap.
		 */
		set maxRetryDelayMs(value: number | undefined) {
			this._maxRetryDelayMs = value;
		}

		get toolExecution(): Loop.ToolExecutionMode {
			return this._toolExecution;
		}

		setToolExecution(value: Loop.ToolExecutionMode) {
			this._toolExecution = value;
		}

		setBeforeToolExecution(
			value:
				| ((
						context: Loop.BeforeToolExecutionContext,
						signal?: AbortSignal,
				  ) => Promise<Loop.BeforeToolCallResult | undefined>)
				| undefined,
		) {
			this._beforeToolExecution = value;
		}

		setAfterToolExecution(
			value:
				| ((
						context: Loop.AfterToolExecutionContext,
						signal?: AbortSignal,
				  ) => Promise<Agent.ToolTerminalResult<unknown> | undefined>)
				| undefined,
		) {
			this._afterToolExecution = value;
		}

		get state(): State {
			return this._state;
		}

		subscribe(fn: (e: Event.AgentEvent) => void): () => void {
			this.listeners.add(fn);
			return () => this.listeners.delete(fn);
		}

		// State mutators
		setSystemPrompt(v: string) {
			this._state.systemPrompt = v;
		}
		setModel(m: Model.Info) {
			this._state.model = m;
		}
		setThinkingLevel(l: Stream.ThinkingLevel) {
			this._state.thinkingLevel = l;
		}
		setSteeringMode(mode: "all" | "one-at-a-time") {
			this.steeringMode = mode;
		}

		getSteeringMode(): "all" | "one-at-a-time" {
			return this.steeringMode;
		}

		setFollowUpMode(mode: "all" | "one-at-a-time") {
			this.followUpMode = mode;
		}

		getFollowUpMode(): "all" | "one-at-a-time" {
			return this.followUpMode;
		}

		setTools(t: AgentTool<any>[]) {
			this._state.tools = t;
		}

		replaceMessages(ms: Message.Message[]) {
			this._state.messages = ms.slice();
		}

		appendMessage(m: Message.Message) {
			this._state.messages = [...this._state.messages, m];
		}

		private findMessageIndexById(messageId: string): number {
			return this._state.messages.findIndex((message) => message.messageId === messageId);
		}

		private replaceMessageById(message: Message.Message): boolean {
			const messageIndex = this.findMessageIndexById(message.messageId);
			if (messageIndex === -1) {
				return false;
			}

			const messages = this._state.messages.slice();
			messages[messageIndex] = message;
			this._state.messages = messages;
			return true;
		}

		private upsertMessage(message: Message.Message): void {
			if (this.replaceMessageById(message)) {
				return;
			}
			this.appendMessage(message);
		}

		private patchStoredAssistantPart(
			messageId: string,
			partIndex: number,
			part: Message.AssistantMessage["parts"][number],
		): boolean {
			const messageIndex = this.findMessageIndexById(messageId);
			if (messageIndex === -1) {
				return false;
			}

			const messages = this._state.messages.slice();
			const existing = messages[messageIndex];
			if (!existing || existing.role !== "assistant") {
				return false;
			}

			const nextParts = existing.parts.slice();
			nextParts[partIndex] = part;
			messages[messageIndex] = {
				...existing,
				parts: nextParts,
			};
			this._state.messages = messages;
			return true;
		}

		/**
		 * Queue a steering message while the agent is running.
		 * Delivered after the current assistant turn finishes executing its tool calls,
		 * before the next LLM call.
		 */
		steer(m: Message.UserMessage) {
			this.steeringQueue.push(m);
		}

		/**
		 * Queue a follow-up message to be processed after the agent finishes.
		 * Delivered only when agent has no more tool calls or steering messages.
		 */
		followUp(m: Message.UserMessage) {
			this.followUpQueue.push(m);
		}

		clearSteeringQueue() {
			this.steeringQueue = [];
		}

		clearFollowUpQueue() {
			this.followUpQueue = [];
		}

		clearAllQueues() {
			this.steeringQueue = [];
			this.followUpQueue = [];
		}

		hasQueuedMessages(): boolean {
			return this.steeringQueue.length > 0 || this.followUpQueue.length > 0;
		}

		private dequeueSteeringMessages(): Message.UserMessage[] {
			if (this.steeringMode === "one-at-a-time") {
				if (this.steeringQueue.length > 0) {
					const first = this.steeringQueue[0]!;
					this.steeringQueue = this.steeringQueue.slice(1);
					return [first];
				}
				return [];
			}

			const steering = this.steeringQueue.slice();
			this.steeringQueue = [];
			return steering;
		}

		private dequeueFollowUpMessages(): Message.UserMessage[] {
			if (this.followUpMode === "one-at-a-time") {
				if (this.followUpQueue.length > 0) {
					const first = this.followUpQueue[0]!;
					this.followUpQueue = this.followUpQueue.slice(1);
					return [first];
				}
				return [];
			}

			const followUp = this.followUpQueue.slice();
			this.followUpQueue = [];
			return followUp;
		}

		clearMessages() {
			this._state.messages = [];
		}

		abort() {
			this.abortController?.abort();
		}

		waitForIdle(): Promise<void> {
			return this.runningPrompt ?? Promise.resolve();
		}

		reset() {
			this._state.messages = [];
			this._state.isStreaming = false;
			this._state.streamMessage = null;
			this._state.pendingToolCalls = new Set<string>();
			this._state.error = undefined;
			this.steeringQueue = [];
			this.followUpQueue = [];
		}

		getName(): string {
			return this._state.name;
		}

		private ensureIdle() {
			if (this._state.isStreaming) {
				throw new AgentInStreamingErr({
					message:
						"agent is already processing a prompt. Use steer() or followup() to queue messages, or wait for completion.",
					name: this._state.name,
				});
			}
		}

		private async _runLoop(messages?: Message.UserMessage[], opts?: { skipInitialSteeringPoll?: boolean }) {
			const model = this._state.model;
			if (!model)
				throw new ModelNotConfiguredErr({
					message: "no model configured yet",
				});

			this.runningPrompt = new Promise<void>((resolve) => {
				this.resolveRunningPrompt = resolve;
			});

			this.abortController = new AbortController();
			this._state.isStreaming = true;
			this._state.streamMessage = null;
			this._state.error = undefined;

			const reasoning = this.state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel;

			const context: Agent.AgentContext = {
				systemPrompt: this._state.systemPrompt,
				messages: this._state.messages.slice(),
				tools: this._state.tools,
			};

			let skipInitialSteeringPoll = opts?.skipInitialSteeringPoll === true;

			const config: Loop.Config = {
				model,
				reasoning,
				sessionId: this._sessionId,
				onPayload: this._onPayload,
				transport: this._transport,
				thinkingBudgets: this._thinkingBudgets,
				maxRetryDelayMs: this._maxRetryDelayMs,
				toolExecution: this._toolExecution,
				beforeToolExecution: this._beforeToolExecution,
				afterToolExecution: this._afterToolExecution,
				convertToLlm: this.convertToLlm,
				transformContext: this.transformContext,
				getApiKey: this.getApiKey,
				getSteeringMessages: async () => {
					if (skipInitialSteeringPoll) {
						skipInitialSteeringPoll = false;
						return [];
					}
					return this.dequeueSteeringMessages();
				},
				getFollowUpMessages: async () => this.dequeueFollowUpMessages(),
			};

			try {
				if (messages) {
					await Loop.runAgentLoop(
						config,
						context,
						messages,
						async (e) => this._processLoopEvent(e),
						this.streamFn,
						this.abortController.signal,
					);
				} else {
					await Loop.runAgentLoopContinue(
						config,
						context,
						async (e) => this._processLoopEvent(e),
						this.streamFn,
						this.abortController.signal,
					);
				}
			} catch (err: any) {
				const message = Message.createAssistantMessage({
					role: "assistant",
					protocol: model.protocol,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: this.abortController.signal.aborted ? "aborted" : "error",
					errorMessage: err?.message || String(err),
					time: {
						created: Date.now(),
						completed: Date.now(),
					},
					parts: [],
				});

				this.appendMessage(message);
				this._state.error = err?.message || String(err);
				this.emit({ type: "agent.end", messages: [message] });
			} finally {
				this._state.isStreaming = false;
				this._state.streamMessage = null;
				this._state.pendingToolCalls = new Set<string>();
				this.abortController = undefined;
				this.resolveRunningPrompt?.();
				this.runningPrompt = undefined;
				this.resolveRunningPrompt = undefined;
			}
		}

		async loop(messages: Message.UserMessage[]): Promise<void> {
			this.ensureIdle();
			await this._runLoop(messages);
		}

		async loopContinue(): Promise<void> {
			this.ensureIdle();
			await this._runLoop();
		}

		async prompt(messages: Message.TextContent[], images?: Message.ImageContent[]): Promise<void> {
			this.ensureIdle();
			const model = this._state.model;
			if (!model)
				throw new ModelNotConfiguredErr({
					message: "no model configured yet.",
				});

			const message = Message.createUserMessage({
				role: "user",
				time: {
					created: Date.now(),
				},
				parts: [...messages, ...(images ?? [])],
			});

			await this.loop([message]);
		}

		private _processLoopEvent(event: Event.AgentEvent): void {
			switch (event.type) {
				case "message.start": {
					this._state.streamMessage = event.message;
					break;
				}
				case "message.part.start":
				case "message.part.update":
				case "message.part.end": {
					this._state.streamMessage = event.message;
					if (event.message.role === "assistant") {
						this.patchStoredAssistantPart(event.message.messageId, event.partIndex, event.part);
					}
					break;
				}
				case "message.update":
					this._state.streamMessage = event.message;
					this.replaceMessageById(event.message);
					break;
				case "message.end":
					this._state.streamMessage = null;
					this.upsertMessage(event.message);
					break;
				case "tool.execution.start": {
					const pendingToolCalls = new Set(this._state.pendingToolCalls);
					pendingToolCalls.add(event.callID);
					this._state.pendingToolCalls = pendingToolCalls;
					break;
				}
				case "tool.execution.end": {
					const pendingToolCalls = new Set(this._state.pendingToolCalls);
					pendingToolCalls.delete(event.callID);
					this._state.pendingToolCalls = pendingToolCalls;
					break;
				}
				case "turn.end":
					if (event.message.role === "assistant" && event.message.parts.length > 0) {
						this._state.error = event.message.errorMessage;
					}
					break;
				case "agent.end":
					this._state.isStreaming = false;
					this._state.streamMessage = null;
					break;
			}
			this.emit(event);
		}

		private emit(e: Event.AgentEvent) {
			for (const listener of this.listeners) {
				listener(e);
			}
		}
	}

	export async function create<TProvider extends Provider.KnownProviderEnum, TModel extends Model.Info["id"]>(
		options: AgentOptions & {
			provider: TProvider;
			model: TModel;
			name?: string;
		},
	): Promise<Instance>;
	export async function create(options: AgentOptions & { model: Model.Info; name?: string }): Promise<Instance>;
	export async function create(
		options:
			| (AgentOptions & { model: Model.Info; name?: string })
			| (AgentOptions & {
					provider: Provider.KnownProviderEnum;
					model: Model.Info["id"];
					name?: string;
			  }),
	): Promise<Instance> {
		let resolvedModel: Model.Info;
		if ("provider" in options) {
			const result = await Model.getModel(options.provider, options.model);
			if (!result) {
				throw new ModelNotFoundErr({
					message: "model not found or not configured yet",
					provider: options.provider,
					model: options.model,
				});
			}
			resolvedModel = result;
		} else {
			resolvedModel = options.model;
		}

		return new Instance(options.name ?? "main", resolvedModel, options);
	}
}
