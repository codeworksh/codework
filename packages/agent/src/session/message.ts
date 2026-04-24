import { type Static, Type } from "@sinclair/typebox";

export namespace Message {
	const Base = Type.Object({
		id: Type.String(),
		sessionID: Type.String(),
		parentMessageID: Type.Union([Type.String(), Type.Null()]),
	});
	const PartBase = Type.Object({
		partID: Type.String(),
		sessionID: Type.String(),
		messageID: Type.String(),
	});

	export const MessageIntent = Type.Union([Type.Literal("followup"), Type.Literal("steer"), Type.Literal("next")], {
		default: "next",
	});
	export type MessageIntent = Static<typeof MessageIntent>;

	const ToolSuccessResult = Type.Object({
		details: Type.Optional(Type.Any()),
		isError: Type.Literal(false),
		time: Type.Object({
			start: Type.Number(), // Unix timestamp in milliseconds
			end: Type.Number(), // Unix timestamp in milliseconds
		}),
	});
	const ToolErrorResult = Type.Object({
		details: Type.Optional(Type.Any()),
		isError: Type.Literal(true),
		time: Type.Object({
			start: Type.Number(), // Unix timestamp in milliseconds
			end: Type.Number(), // Unix timestamp in milliseconds
		}),
	});

	export const TextPart = Type.Intersect([PartBase], { $id: "TextPart" });
	export const ImagePart = Type.Intersect([PartBase], { $id: "ImagePart" });
	export type TextPart = Static<typeof TextPart>;
	export type ImagePart = Static<typeof ImagePart>;

	export const ThinkingPart = Type.Intersect([PartBase], {
		$id: "ThinkingPart",
	});
	const ToolCallPartBase = Type.Intersect([
		PartBase,
		Type.Object({
			invokeID: Type.String(),
		}),
	]);
	const ToolCallPendingPart = Type.Intersect([
		ToolCallPartBase,
		Type.Object({
			status: Type.Literal("pending"),
		}),
	]);
	const ToolCallRunningPart = Type.Intersect([
		ToolCallPartBase,
		Type.Object({
			status: Type.Literal("running"),
		}),
	]);
	const ToolCallCompletedPart = Type.Intersect([
		ToolCallPartBase,
		Type.Object({
			status: Type.Literal("completed"),
			result: ToolSuccessResult,
		}),
	]);
	const ToolCallErrorPart = Type.Intersect([
		ToolCallPartBase,
		Type.Object({
			status: Type.Literal("error"),
			result: ToolErrorResult,
		}),
	]);
	const ToolCallSkippedPart = Type.Intersect([
		ToolCallPartBase,
		Type.Object({
			status: Type.Literal("skipped"),
			result: ToolErrorResult,
		}),
	]);
	const ToolCallAbortedPart = Type.Intersect([
		ToolCallPartBase,
		Type.Object({
			status: Type.Literal("aborted"),
			result: ToolErrorResult,
		}),
	]);
	export const ToolCallPart = Type.Union(
		[
			ToolCallPendingPart,
			ToolCallRunningPart,
			ToolCallCompletedPart,
			ToolCallErrorPart,
			ToolCallSkippedPart,
			ToolCallAbortedPart,
		],
		{
			$id: "ToolCallPart",
		},
	);
	export type ThinkingPart = Static<typeof ThinkingPart>;
	export type ToolCallPart = Static<typeof ToolCallPart>;

	export const User = Type.Intersect(
		[
			Base,
			Type.Object({
				role: Type.Literal("user"),
				time: Type.Object({
					created: Type.Number(),
				}),
				intent: MessageIntent,
			}),
		],
		{ $id: "UserMessage" },
	);
	export type User = Static<typeof User>;

	export const Assistant = Type.Intersect(
		[
			Base,
			Type.Object({
				role: Type.Literal("assistant"),
				time: Type.Object({
					created: Type.Number(),
					completed: Type.Number(),
				}),
				provider: Type.Unsafe<string>({ type: "string" }),
				model: Type.String(),
				// usage: UsageSchema,
				// stopReason: StopReasonSchema,
				// errorMessage: Type.Optional(Type.String()),
			}),
		],
		{ $id: "AssistantMessage" },
	);
	export type Assistant = Static<typeof Assistant>;

	export const Info = Type.Union([User, Assistant], { $id: "Message" });
	export type Info = Static<typeof Info>;

	export const Part = Type.Union([TextPart, ImagePart, ThinkingPart, ToolCallPart]);
	export type Part = Static<typeof Part>;

	export const WithParts = Type.Object({
		info: Info,
		parts: Type.Array(Part),
	});
	export type WithParts = Static<typeof WithParts>;
}
