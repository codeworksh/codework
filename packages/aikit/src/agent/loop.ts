import type { Event } from "../event/event";
import type { Message } from "../message/message";
import type { Model } from "../model/model";
import type { Provider } from "../provider/provider";
import { Stream } from "../provider/stream";
import { EventStream } from "../utils/eventstream";
import { validateToolArguments } from "../utils/validation";
import type { Agent } from "./agent";

export namespace Loop {
	/** Stream function - can return sync or Promise for async config lookup */
	export type StreamFn = (
		...args: Parameters<typeof Stream.streamSimple>
	) => ReturnType<typeof Stream.streamSimple> | Promise<ReturnType<typeof Stream.streamSimple>>;

	/**
	 * Configuration for how tool calls from a single assistant message are executed.
	 *
	 * - "sequential": each tool call is prepared, executed, and finalized before the next one starts.
	 * - "parallel": tool calls are prepared sequentially, then allowed tools execute concurrently.
	 *   Final tool results are still emitted in assistant source order.
	 */
	export type ToolExecutionMode = "sequential" | "parallel";

	/** Context passed to `beforeToolExecution`. */
	export interface BeforeToolExecutionContext {
		/** The current context at the time the tool call is prepared */
		context: Agent.AgentContext;
		/** The assistant message that requested the tool call. */
		assistantMessage: Message.AssistantMessage;
		/** The validated in-flight tool call with validated arguments */
		toolCall: Agent.ToolCallInFlight;
	}

	/** Context passed to `afterToolExecution`. */
	export interface AfterToolExecutionContext {
		/** Current agent context at the time the tool call is finalized. */
		context: Agent.AgentContext;
		/** The assistant message that requested the tool call. */
		assistantMessage: Message.AssistantMessage;
		/** The validated in-flight tool call with validated arguments */
		toolCall: Agent.ToolCallInFlight;
		/** The executed tool result before any `afterToolExecution` overrides are applied. */
		result: Agent.ToolTerminalResult<any>;
	}

	/**
	 * Result returned from `beforeToolExecution`.
	 *
	 * Returning `{ block: true }` prevents the tool from executing. The loop emits an error tool result instead.
	 * `reason` becomes the text shown in that error result. If omitted, a default blocked message is used.
	 */
	export interface BeforeToolCallResult<T = any> {
		block?: boolean;
		reason?: string;
		details?: T;
	}

	/** Configuration for the agent loop. */
	export interface Config extends Stream.SimpleOptions {
		model: Model.Value;
		convertToLlm: (messages: Message.Message[]) => Message.Message[] | Promise<Message.Message[]>;
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
		 * Resolves an API key dynamically for each LLM call.
		 *
		 * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
		 * during long-running tool execution phases.
		 */
		getApiKey?: (provider: Provider.Info) => Promise<string | undefined> | string | undefined;
		/**
		 * Returns steering messages to inject into the conversation mid-run.
		 *
		 * Called after each tool execution to check for user interruptions.
		 * If messages are returned, remaining tool calls are skipped and
		 * these messages are added to the context before the next LLM call.
		 *
		 * Use this for "steering" the agent while it's working.
		 */
		getSteeringMessages?: () => Promise<Message.UserMessage[]>;
		/**
		 * Returns follow-up messages to process after the agent would otherwise stop.
		 *
		 * Called when the agent has no more tool calls and no steering messages.
		 * If messages are returned, they're added to the context and the agent
		 * continues with another turn.
		 *
		 * Use this for follow-up messages that should wait until the agent finishes.
		 */
		getFollowUpMessages?: () => Promise<Message.UserMessage[]>;

		/**
		 * Tool execution mode.
		 * - "sequential": execute tool calls one by one
		 * - "parallel": preflight tool calls sequentially, then execute allowed tools concurrently
		 *
		 * Default: "parallel"
		 */
		toolExecution?: ToolExecutionMode;

		/**
		 * Called before a tool is executed, after arguments have been validated.
		 *
		 * Return `{ block: true }` to prevent execution. The loop emits an error tool result instead.
		 * The hook receives the agent abort signal and is responsible for honoring it.
		 */
		beforeToolExecution?: (
			context: BeforeToolExecutionContext,
			signal?: AbortSignal,
		) => Promise<BeforeToolCallResult | undefined>;

		/**
		 * Called after a tool finishes executing, before final tool events are emitted.
		 *
		 * Any omitted fields keep their original values. No deep merge is performed.
		 * The hook receives the agent abort signal and is responsible for honoring it.
		 */
		afterToolExecution?: (
			context: AfterToolExecutionContext,
			signal?: AbortSignal,
		) => Promise<Agent.ToolTerminalResult<any> | undefined>;
	}

	function createAgentStream(): EventStream<Event.AgentEvent, Message.Message[]> {
		return new EventStream<Event.AgentEvent, Message.Message[]>(
			(event: Event.AgentEvent) => event.type === "agent_end",
			(event: Event.AgentEvent) => (event.type === "agent_end" ? event.messages : []),
		);
	}

	type AssistantPart = Message.AssistantMessage["parts"][number];

	type ToolCallPart = Message.ToolCallPendingPart & { partIndex: number }; // runtime toolcall pending part

	type ToolCallPrepared =
		| {
				error: {
					kind: "error" | "blocked";
					message: string;
					details?: any;
				};
				runnable: Agent.ToolCallInFlight;
		  }
		| {
				error?: never;
				runnable: Agent.ToolCallInFlight;
				tool: Agent.AnyAgentTool;
		  };

	type ToolCallRunnable = {
		toolCall: ToolCallPart;
		runnable: Agent.ToolCallInFlight;
		tool: Agent.AnyAgentTool;
	};

	type ToolCallExecutionResult<T = any> =
		| { result: Agent.ToolTerminalResult<T>; error?: never }
		| { result?: never; error: { message: string; details?: any } };

	function snapshotAssistantMessage(message: Message.AssistantMessage): Message.AssistantMessage {
		return structuredClone(message);
	}

	function snapshotAssistantPartEvent(
		message: Message.AssistantMessage,
		partIndex: number,
	): { message: Message.AssistantMessage; part: AssistantPart } {
		const snapshot = snapshotAssistantMessage(message);
		const part = snapshot.parts[partIndex];
		if (!part) {
			throw new Error(`Assistant message part at index ${partIndex} was not found`);
		}
		return { message: snapshot, part };
	}

	async function streamAssistantResponse(
		config: Config,
		context: Agent.AgentContext,
		stream: EventStream<Event.AgentEvent, Message.Message[]>,
		streamFn?: StreamFn,
		signal?: AbortSignal,
	): Promise<Message.AssistantMessage> {
		// FIXME @sanchitrk:
		// Have something like a pipeline with Message.Message[] transformation
		// caller will inject transfomers[](async functions) that is then invoked in order

		// Apply context transform if configured (Message.Message[] → Message.Message[])
		let messages = context.messages;
		if (config.transformContext) {
			messages = await config.transformContext(messages, signal);
		}

		// Convert to LLM-compatible messages (Message.Message[] → Message.Message[])
		const llmMessages = await config.convertToLlm(messages);

		// Build LLM context, subset of Agent.AgentContext
		const llmContext: Agent.AgentContext = {
			systemPrompt: context.systemPrompt,
			messages: llmMessages,
			tools: context.tools,
		};
		const streamFunction = streamFn || Stream.streamSimple;
		// Resolve API key (important for expiring tokens)
		// TODO @sanchitrk:
		// improve passing of credentials (key/oauth), provider also has resolve api key,
		// for now its dummy implementation.
		const resolvedApiKey =
			(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

		const events = await streamFunction(config.model, llmContext, {
			...config,
			apiKey: resolvedApiKey,
			signal,
		});

		let partialMessage: Message.AssistantMessage | null = null;
		let started = false;

		const ensureMessageStarted = (message: Message.AssistantMessage): void => {
			if (started) return;
			started = true;
			stream.push({ type: "message_start", message: snapshotAssistantMessage(message) });
		};

		const emitMessageUpdate = (message: Message.AssistantMessage): void => {
			stream.push({ type: "message_update", message: snapshotAssistantMessage(message) });
		};

		const emitPartStart = (message: Message.AssistantMessage, partIndex: number): void => {
			const snapshot = snapshotAssistantPartEvent(message, partIndex);
			stream.push({ type: "message_part_start", partIndex, ...snapshot });
		};

		const emitPartUpdate = (message: Message.AssistantMessage, partIndex: number): void => {
			const snapshot = snapshotAssistantPartEvent(message, partIndex);
			stream.push({ type: "message_part_update", partIndex, ...snapshot, source: "llm" });
		};

		const emitPartEnd = (message: Message.AssistantMessage, partIndex: number): void => {
			const snapshot = snapshotAssistantPartEvent(message, partIndex);
			stream.push({ type: "message_part_end", partIndex, ...snapshot });
		};

		// NOTE: Do not mutate context directly
		// once all the events are done return message
		// mutate partialMessage and corresponding parts as required
		// return the final built message form llm events
		for await (const event of events) {
			switch (event.type) {
				case "start": {
					partialMessage = event.partial;
					ensureMessageStarted(partialMessage);
					break;
				}
				case "text_start":
				case "thinking_start":
				case "toolcall_start": {
					partialMessage = event.partial;
					ensureMessageStarted(partialMessage);
					emitPartStart(partialMessage, event.partIndex);
					break;
				}
				case "text_delta":
				case "thinking_delta":
				case "toolcall_delta": {
					partialMessage = event.partial;
					ensureMessageStarted(partialMessage);
					emitPartUpdate(partialMessage, event.partIndex);
					break;
				}
				case "text_end":
				case "thinking_end":
				case "toolcall_end": {
					partialMessage = event.partial;
					ensureMessageStarted(partialMessage);
					emitPartEnd(partialMessage, event.partIndex);
					emitMessageUpdate(partialMessage);
					break;
				}
				case "done": {
					ensureMessageStarted(event.message);
					stream.push({ type: "message_end", message: snapshotAssistantMessage(event.message) });
					return event.message;
				}
				case "error": {
					ensureMessageStarted(event.error);
					stream.push({ type: "message_end", message: snapshotAssistantMessage(event.error) });
					return event.error;
				}
			}
		}

		const finalMessage = await events.result();
		ensureMessageStarted(finalMessage);
		stream.push({ type: "message_end", message: snapshotAssistantMessage(finalMessage) });
		return finalMessage;
	}

	async function runLoop(
		config: Config,
		currentContext: Agent.AgentContext,
		newMessages: Message.Message[],
		stream: EventStream<Event.AgentEvent, Message.Message[]>,
		streamFn?: StreamFn,
		signal?: AbortSignal,
	): Promise<void> {
		// initial `turn_start` is already emitted
		// avoiding duplicate `turn_start` emits
		let firstTurn = true;
		// Check for steering messages at start (user may have submitted while waiting)
		let pendingMessages: Message.UserMessage[] = (await config.getSteeringMessages?.()) || [];

		// Outer loop: continues when queued follow-up messages arrive after agent would stop
		while (true) {
			let hasMoreToolCalls = true;

			// Inner loop: process tool calls and steering messages
			// Note: turn_start for full tool calls / pending messages.
			while (hasMoreToolCalls || pendingMessages.length > 0) {
				// flip firstTurn, so next iterations starts emitting `turn_start` event
				if (!firstTurn) {
					stream.push({ type: "turn_start" });
				} else {
					firstTurn = false;
				}

				// Process pending messages (inject before next assistant response)
				if (pendingMessages.length > 0) {
					for (const message of pendingMessages) {
						stream.push({ type: "message_start", message: message });
						for (const [partIndex, part] of message.parts.entries()) {
							stream.push({ type: "message_part_start", message: message, partIndex, part });
							stream.push({ type: "message_part_end", message: message, partIndex, part });
							stream.push({ type: "message_update", message: message });
						}
						stream.push({ type: "message_end", message: message });
						currentContext.messages.push(message);
						newMessages.push(message);
					}
					pendingMessages = [];
				}

				// Run llm and stream assistant response
				const message: Message.AssistantMessage = await streamAssistantResponse(
					config,
					currentContext,
					stream,
					streamFn,
					signal,
				);

				// terminal state
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					currentContext.messages.push(message); // append the terminal message into the context
					newMessages.push(message); // append the terminal message

					stream.push({ type: "turn_end", message });
					stream.push({ type: "agent_end", messages: newMessages });
					stream.end(newMessages);

					return;
				}

				// check for pending tool calls
				// use partIndex for in-place mutation for tool call result parts in message.parts
				const toolCalls: ToolCallPart[] = message.parts
					.map((part, index) => ({ ...part, partIndex: index }))
					.filter((part) => part.type === "toolCall" && part.status === "pending");

				hasMoreToolCalls = toolCalls.length > 0;
				if (hasMoreToolCalls) {
					await executeToolCalls(config, currentContext, message, toolCalls, stream, signal);
				}

				currentContext.messages.push(message);
				newMessages.push(message);

				stream.push({ type: "turn_end", message });

				//
				// check for steering messages while turn loop was working.
				pendingMessages = (await config.getSteeringMessages?.()) || [];
			}

			// Agent would stop here. Check for follow-up messages.
			const followUpMessages = (await config.getFollowUpMessages?.()) || [];
			if (followUpMessages.length > 0) {
				// Set as pending so inner loop processes them
				pendingMessages = followUpMessages;
				continue;
			}

			// No more messages, exit
			break;
		}

		stream.push({ type: "agent_end", messages: newMessages });
	}

	async function executeToolCalls(
		config: Config,
		currentContext: Agent.AgentContext,
		message: Message.AssistantMessage,
		toolCalls: ToolCallPart[],
		stream: EventStream<Event.AgentEvent, Message.Message[]>,
		signal?: AbortSignal,
	): Promise<void> {
		if (config.toolExecution === "sequential")
			return executeToolCallsSequential(config, currentContext, message, toolCalls, stream, signal);
		return executeToolCallsParallel(config, currentContext, message, toolCalls, stream, signal);
	}

	async function executeToolCallsSequential(
		config: Config,
		currentContext: Agent.AgentContext,
		message: Message.AssistantMessage,
		toolCalls: ToolCallPart[],
		stream: EventStream<Event.AgentEvent, Message.Message[]>,
		signal?: AbortSignal,
	): Promise<void> {
		for (const toolCall of toolCalls) {
			const toolCallInFlight: Agent.ToolCallInFlight = {
				callID: toolCall.callID,
				name: toolCall.name,
				rawArgs: toolCall.arguments,
			};
			stream.push({
				type: "tool_execution_start",
				...toolCallInFlight,
			});
			//
			// Prepares the tool call for execution.
			// Invokes a pre-execution callback with the current context, allowing
			// the callback to either continue or block (short-circuiting the execution).
			// Mutates `message.parts` in-place to update the pending tool call with its result.
			const prepared = await prepareToolCall(config, currentContext, message, toolCallInFlight, signal);
			if (prepared.error) {
				const error: Agent.ToolErrorResult<any> = {
					status: "error",
					result: {
						content: [{ type: "text", text: prepared.error.message }],
						details: prepared.error.details,
						isError: true,
					},
				};
				await emitToolCallTerminalResult(toolCall, prepared.runnable, message, stream, error);
			} else {
				const runnable: ToolCallRunnable = {
					toolCall,
					runnable: prepared.runnable,
					tool: prepared.tool,
				};
				const executed = await executeRunnableToolCall(runnable, message, stream, signal);
				if (executed.error) {
					// tool call invocation failed with error
					// create tool error result
					const error: Agent.ToolErrorResult<any> = {
						status: "error",
						result: {
							content: [{ type: "text", text: executed.error.message }],
							details: executed.error.details,
							isError: true,
						},
					};
					await emitToolCallTerminalResult(runnable.toolCall, runnable.runnable, message, stream, error);
				} else {
					// finalize results from tool invocation
					// invokes after tool exection callback
					await finalizeExecutedToolCall(
						config,
						currentContext,
						runnable.toolCall,
						runnable.runnable,
						message,
						stream,
						executed.result,
					);
				}
			}
		}
	}

	async function executeToolCallsParallel(
		config: Config,
		currentContext: Agent.AgentContext,
		message: Message.AssistantMessage,
		toolCalls: ToolCallPart[],
		stream: EventStream<Event.AgentEvent, Message.Message[]>,
		signal?: AbortSignal,
	): Promise<void> {
		const runnables: ToolCallRunnable[] = [];

		for (const toolCall of toolCalls) {
			const toolCallInFlight: Agent.ToolCallInFlight = {
				callID: toolCall.callID,
				name: toolCall.name,
				rawArgs: toolCall.arguments,
			};
			stream.push({
				type: "tool_execution_start",
				...toolCallInFlight,
			});
			//
			// Prepares the tool call for execution.
			// Invokes a pre-execution callback with the current context, allowing
			// the callback to either continue or block (short-circuiting the execution).
			// Mutates `message.parts` in-place to update the pending tool call with its result.
			const prepared = await prepareToolCall(config, currentContext, message, toolCallInFlight, signal);
			if (prepared.error) {
				const error: Agent.ToolErrorResult<any> = {
					status: "error",
					result: {
						content: [{ type: "text", text: prepared.error.message }],
						details: prepared.error.details,
						isError: true,
					},
				};
				await emitToolCallTerminalResult(toolCall, prepared.runnable, message, stream, error);
			} else {
				runnables.push({
					toolCall,
					runnable: prepared.runnable,
					tool: prepared.tool,
				});
			}
		}

		const runningExecutions = runnables.map((runnable) => ({
			runnable,
			execution: executeRunnableToolCall(runnable, message, stream, signal),
		}));

		for (const running of runningExecutions) {
			const executed = await running.execution;
			const { runnable } = running;
			if (executed.error) {
				// tool call invocation failed with error
				// create tool error result
				const error: Agent.ToolErrorResult<any> = {
					status: "error",
					result: {
						content: [{ type: "text", text: executed.error.message }],
						details: executed.error.details,
						isError: true,
					},
				};
				await emitToolCallTerminalResult(runnable.toolCall, runnable.runnable, message, stream, error);
			} else {
				// finalize results from tool invocation
				// invokes after tool exection callback
				await finalizeExecutedToolCall(
					config,
					currentContext,
					runnable.toolCall,
					runnable.runnable,
					message,
					stream,
					executed.result,
				);
			}
		}
	}

	async function prepareToolCall(
		config: Config,
		currentContext: Agent.AgentContext,
		assistantMessage: Message.AssistantMessage,
		toolCallInFlight: Agent.ToolCallInFlight,
		signal?: AbortSignal,
	): Promise<ToolCallPrepared> {
		const tool = currentContext.tools?.find((t) => t.name === toolCallInFlight.name);
		if (!tool) {
			return {
				error: {
					kind: "error",
					message: `Tool ${toolCallInFlight.name} Not Found`,
				},
				runnable: toolCallInFlight,
			};
		}

		try {
			//
			// first validate toolcall args, before invoking callback
			// appends validated args
			toolCallInFlight.args = validateToolArguments(tool, toolCallInFlight);
			if (config.beforeToolExecution) {
				const beforeResult = await config.beforeToolExecution(
					{
						context: currentContext,
						assistantMessage,
						toolCall: toolCallInFlight,
					},
					signal,
				);
				if (beforeResult?.block) {
					return {
						error: {
							kind: "blocked",
							message: beforeResult?.reason || "Tool Execution was Blocked",
							details: beforeResult?.details,
						},
						runnable: toolCallInFlight,
					};
				}
			}
			return {
				runnable: toolCallInFlight,
				tool: tool as Agent.AnyAgentTool,
			};
		} catch (err) {
			return {
				error: {
					kind: "error",
					message: err instanceof Error ? err.message : String(err),
				},
				runnable: toolCallInFlight,
			};
		}
	}

	async function executeRunnableToolCall(
		toolCallRunnable: ToolCallRunnable,
		message: Message.AssistantMessage,
		stream: EventStream<Event.AgentEvent, Message.Message[]>,
		signal?: AbortSignal,
	): Promise<ToolCallExecutionResult> {
		const { toolCall, runnable, tool } = toolCallRunnable;
		const { partIndex, ...pendingPart } = toolCall;
		try {
			const result = await tool.execute(runnable.callID, runnable.args, signal, (result) => {
				const runningResult: Agent.ToolRunningResult<any> = {
					status: "running",
					partial: result.partial,
				};
				const toolExecutionUpdate: Event.ToolExecutionUpdate = {
					type: "tool_execution_update",
					...runnable,
					...runningResult,
				};
				stream.push({ ...toolExecutionUpdate });

				const runningPart: Message.ToolCallRunningPart = {
					...pendingPart,
					...runningResult,
				};

				message.parts[partIndex] = runningPart; // in-place mutate; add error part

				stream.push({ type: "message_part_update", message, partIndex, part: runningPart, source: "tool" });
			});
			return {
				result,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				error: {
					message,
				},
			};
		}
	}

	async function emitToolCallTerminalResult(
		toolCall: ToolCallPart,
		runnable: Agent.ToolCallInFlight,
		message: Message.AssistantMessage,
		stream: EventStream<Event.AgentEvent, Message.Message[]>,
		result: Agent.ToolTerminalResult<any>,
	): Promise<void> {
		const { partIndex, ...pendingPart } = toolCall;
		const { time } = pendingPart;
		const toolExecutionEnd: Event.ToolExecutionEnd = {
			type: "tool_execution_end",
			...runnable,
			...result,
		};
		stream.push({ ...toolExecutionEnd });

		const part: Message.ToolCallErrorPart | Message.ToolCallCompletedPart = {
			...pendingPart,
			...result,
			time: {
				start: time.start,
				end: Date.now(),
			},
		};

		message.parts[partIndex] = part; // in-place mutate; add error part

		stream.push({ type: "message_part_start", message: message, partIndex: partIndex, part: part });
		stream.push({ type: "message_part_end", message: message, partIndex: partIndex, part: part });
		stream.push({ type: "message_update", message: message });
	}

	async function finalizeExecutedToolCall(
		config: Config,
		currentContext: Agent.AgentContext,
		toolCall: ToolCallPart,
		runnable: Agent.ToolCallInFlight,
		message: Message.AssistantMessage,
		stream: EventStream<Event.AgentEvent, Message.Message[]>,
		result: Agent.ToolTerminalResult<any>,
		signal?: AbortSignal,
	): Promise<void> {
		if (config.afterToolExecution) {
			const afterResult = await config.afterToolExecution(
				{
					context: currentContext,
					assistantMessage: message,
					toolCall: runnable,
					result,
				},
				signal,
			);
			if (afterResult) {
				await emitToolCallTerminalResult(toolCall, runnable, message, stream, afterResult);
				return;
			}
		}
		await emitToolCallTerminalResult(toolCall, runnable, message, stream, result);
	}

	export function agentLoop(
		config: Config,
		context: Agent.AgentContext,
		prompts: Message.UserMessage[],
		streamFn?: StreamFn,
		signal?: AbortSignal,
	): EventStream<Event.AgentEvent, Message.Message[]> {
		const stream = createAgentStream();
		/**
		 * maintain 2 arrays to represent state, `context` the actual full state sent to the LLM,
		 * `newMessages` for intermediate current loop state.
		 * think of newMessages as subset of context.messages for the running current loop.
		 * they do move at the same speed staring with initial user prompts.
		 * */
		(async () => {
			void config;
			void signal;
			void streamFn;
			const newMessages: Message.Message[] = [...prompts];
			const currentContext: Agent.AgentContext = {
				...context,
				messages: [...context.messages, ...prompts],
			};

			stream.push({ type: "agent_start" });
			stream.push({ type: "turn_start" });
			for (const prompt of prompts) {
				stream.push({ type: "message_start", message: prompt });
				for (const [partIndex, part] of prompt.parts.entries()) {
					stream.push({ type: "message_part_start", message: prompt, partIndex, part });
					stream.push({ type: "message_part_end", message: prompt, partIndex, part });
				}
				stream.push({ type: "message_end", message: prompt });
			}

			await runLoop(config, currentContext, newMessages, stream, streamFn, signal);
		})();

		return stream;
	}

	export function agentLoopContinue(): EventStream<Event.AgentEvent, Message.Message[]> {
		return createAgentStream();
	}
}
