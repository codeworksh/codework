import Type, { type Static, type TSchema } from "typebox";
import { uuidv7 } from "uuidv7";
import { Model } from "../model/model";
import { Provider } from "../provider/provider";

export namespace Message {
	export const TextContentSchema = Type.Object({
		type: Type.Literal("text"),
		text: Type.String(),
		textSignature: Type.Optional(Type.String()), // e.g., for OpenAI responses, the message ID
	});
	export type TextContent = Static<typeof TextContentSchema>;

	export const ImageContentSchema = Type.Object({
		type: Type.Literal("image"),
		data: Type.String(), // base64 encoded image data
		mimeType: Type.String(), // e.g., "image/jpeg", "image/png"
	});
	export type ImageContent = Static<typeof ImageContentSchema>;

	export const ThinkingContentSchema = Type.Object({
		type: Type.Literal("thinking"),
		thinking: Type.String(),
		thinkingSignature: Type.Optional(Type.String()), // e.g., for OpenAI responses, the reasoning item ID
		/** When true, the thinking content was redacted by safety filters. The opaque
		 *  encrypted payload is stored in `thinkingSignature` so it can be passed back
		 *  to the API for multi-turn continuity. */
		redacted: Type.Optional(Type.Boolean()),
	});
	export type ThinkingContent = Static<typeof ThinkingContentSchema>;

	export const ToolCallBaseSchema = Type.Object({
		type: Type.Literal("toolCall"),
		callID: Type.String(),
		name: Type.String(),
		arguments: Type.Record(Type.String(), Type.Any()),
		thoughtSignature: Type.Optional(Type.String()), // Google-specific: opaque signature for reusing thought context
		time: Type.Object({
			start: Type.Number(), // Unix timestamp in milliseconds
			end: Type.Number(), // Unix timestamp in milliseconds, last known lifecycle update
		}),
	});

	export const ToolSuccessResult = Type.Object({
		content: Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
		details: Type.Optional(Type.Any()),
		isError: Type.Literal(false),
	});
	export const ToolErrorResult = Type.Object({
		content: Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
		details: Type.Optional(Type.Any()),
		isError: Type.Literal(true),
	});
	export const ToolRunningPartial = Type.Object({
		content: Type.Optional(Type.Array(Type.Union([TextContentSchema, ImageContentSchema]))),
		details: Type.Optional(Type.Any()),
	});

	export const ToolStatusEnum = {
		pending: "pending",
		running: "running",
		completed: "completed",
		error: "error",
		skipped: "skipped",
		aborted: "aborted",
	} as const;

	export const ToolRunningSchema = Type.Object({
		status: Type.Literal(ToolStatusEnum.running),
		partial: Type.Optional(ToolRunningPartial),
	});
	export const ToolCompletedSchema = Type.Object({
		status: Type.Literal(ToolStatusEnum.completed),
		result: ToolSuccessResult,
	});
	export const ToolErrorSchema = Type.Object({
		status: Type.Literal(ToolStatusEnum.error),
		result: ToolErrorResult,
	});
	export const ToolSkippedSchema = Type.Object({
		status: Type.Literal(ToolStatusEnum.skipped),
		result: ToolErrorResult,
	});
	export const ToolAbortedSchema = Type.Object({
		status: Type.Literal(ToolStatusEnum.aborted),
		result: ToolErrorResult,
	});

	const ToolCallPendingPart = Type.Intersect([
		ToolCallBaseSchema,
		Type.Object({
			status: Type.Literal(ToolStatusEnum.pending),
		}),
	]);
	const ToolCallRunningPart = Type.Evaluate(Type.Intersect([ToolCallBaseSchema, ToolRunningSchema]));
	const ToolCallCompletedPart = Type.Evaluate(Type.Intersect([ToolCallBaseSchema, ToolCompletedSchema]));
	const ToolCallErrorPart = Type.Evaluate(Type.Intersect([ToolCallBaseSchema, ToolErrorSchema]));
	const ToolCallSkippedPart = Type.Evaluate(Type.Intersect([ToolCallBaseSchema, ToolSkippedSchema]));
	const ToolCallAbortedPart = Type.Evaluate(Type.Intersect([ToolCallBaseSchema, ToolAbortedSchema]));

	export const ToolCallSchema = Type.Union([
		ToolCallPendingPart,
		ToolCallRunningPart,
		ToolCallCompletedPart,
		ToolCallErrorPart,
		ToolCallSkippedPart,
		ToolCallAbortedPart,
	]);

	export type ToolCall = Static<typeof ToolCallSchema>;
	export type ToolCallPendingPart = Static<typeof ToolCallPendingPart>;
	export type ToolCallRunningPart = Static<typeof ToolCallRunningPart>;
	export type ToolCallCompletedPart = Static<typeof ToolCallCompletedPart>;
	export type ToolCallErrorPart = Static<typeof ToolCallErrorPart>;

	export const UsageSchema = Type.Object({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		totalTokens: Type.Number(),
		cost: Type.Object({
			input: Type.Number(),
			output: Type.Number(),
			cacheRead: Type.Number(),
			cacheWrite: Type.Number(),
			total: Type.Number(),
		}),
	});
	export type Usage = Static<typeof UsageSchema>;

	export const StopReasonSchema = Type.Union([
		Type.Literal("stop"),
		Type.Literal("length"),
		Type.Literal("toolUse"),
		Type.Literal("error"),
		Type.Literal("aborted"),
	]);
	export type StopReason = Static<typeof StopReasonSchema>;

	export const UserMessageSchema = Type.Object({
		messageId: Type.String(),
		role: Type.Literal("user"),
		time: Type.Object({
			created: Type.Number(),
		}),
		parts: Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
	});
	export type UserMessage = Static<typeof UserMessageSchema>;

	export const AssistantMessageSchema = Type.Object({
		role: Type.Literal("assistant"),
		protocol: Model.KnownProtocolSchema,
		provider: Provider.Info,
		model: Type.String(),
		usage: UsageSchema,
		stopReason: StopReasonSchema,
		errorMessage: Type.Optional(Type.String()),
		time: Type.Object({
			created: Type.Number(),
			completed: Type.Number(),
		}),
		parts: Type.Array(Type.Union([TextContentSchema, ImageContentSchema, ThinkingContentSchema, ToolCallSchema])),
		responseId: Type.Optional(Type.String()), // Provider-specific response/message identifier when the upstream API exposes one
		messageId: Type.String(),
	});
	export type AssistantMessage = Static<typeof AssistantMessageSchema>;

	export const MessageSchema = Type.Union([UserMessageSchema, AssistantMessageSchema]);
	export type Message = Static<typeof MessageSchema>;

	type UserMessageInit = Omit<UserMessage, "messageId"> & {
		messageId?: string;
	};

	type AssistantMessageInit = Omit<AssistantMessage, "messageId"> & {
		messageId?: string;
	};

	export function createMessageId(): string {
		return uuidv7();
	}

	export function createUserMessage(message: UserMessageInit): UserMessage {
		const { messageId = createMessageId(), ...rest } = message;
		return {
			messageId,
			...rest,
		};
	}

	export function createAssistantMessage(message: AssistantMessageInit): AssistantMessage {
		const { messageId = createMessageId(), ...rest } = message;
		return {
			messageId,
			...rest,
		};
	}

	/**
	 * Generic tool definition with typed parameter schema.
	 * Usage:
	 *
	 * const search = Message.defineTool({
	 *   name: "search",
	 *   description: "Search documents",
	 *   parameters: Type.Object({
	 *     query: Type.String(),
	 *     limit: Type.Optional(Type.Number()),
	 *   }),
	 * });
	 *
	 * type SearchParams = Static<typeof search.parameters>;
	 */
	export const ToolSchema = Type.Object({
		name: Type.String(),
		description: Type.String(),
		parameters: Type.Unsafe<TSchema>({}),
	});
	export interface Tool<TParameters extends TSchema = TSchema> {
		name: string;
		description: string;
		parameters: TParameters;
	}
	export type ToolArguments<T extends Tool> = Static<T["parameters"]>;

	export function defineTool<TParameters extends TSchema>(tool: Tool<TParameters>): Tool<TParameters> {
		return tool;
	}

	export const ContextSchema = Type.Object({
		systemPrompt: Type.Optional(Type.String()),
		messages: Type.Array(MessageSchema),
		tools: Type.Optional(Type.Array(ToolSchema)),
	});
	export type Context = Static<typeof ContextSchema>;

	export function transformMessages<TProtocol extends Model.KnownProtocol>(
		messages: Message[],
		model: Model.TModel<TProtocol>,
		normalizeToolCallId?: (id: string, model: Model.TModel<TProtocol>, source: AssistantMessage) => string,
	): Message[] {
		const toolCallIDMap = new Map<string, string>();

		const transformed: Message[] = [];
		for (const msg of messages) {
			if (msg.role === "user") {
				transformed.push(msg);
				continue;
			}

			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider.id === model.provider.id &&
				assistantMsg.protocol === model.protocol &&
				assistantMsg.model === model.id;

			const parts = assistantMsg.parts.flatMap((block) => {
				if (block.type === "thinking") {
					if (isSameModel && block.thinkingSignature) return block;
					if (!block.thinking || block.thinking.trim() === "") return [];
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.thinking,
					};
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					const normalizedID = toolCallIDMap.get(block.callID);
					if (normalizedID && normalizedID !== block.callID) {
						normalizedToolCall = { ...normalizedToolCall, callID: normalizedID };
					} else if (!isSameModel && normalizeToolCallId) {
						const nextID = normalizeToolCallId(toolCall.callID, model, assistantMsg);
						if (nextID !== toolCall.callID) {
							toolCallIDMap.set(toolCall.callID, nextID);
							normalizedToolCall = { ...normalizedToolCall, callID: nextID };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			transformed.push({
				...assistantMsg,
				parts,
			});
		}

		return transformed;
	}
}
