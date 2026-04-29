import { type Static, Type } from "@sinclair/typebox";
import { Message as AikitMessage } from "@codeworksh/aikit";

export namespace Message {
	const Base = Type.Object({
		id: Type.String(),
		sessionId: Type.String(),
		parentMessageId: Type.Union([Type.String(), Type.Null()]),
	});
	const PartBase = Type.Object({
		partId: Type.String(),
		sessionId: Type.String(),
		messageId: Type.String(),
	});

	export const MessageIntent = Type.Union([Type.Literal("followup"), Type.Literal("steer"), Type.Literal("next")], {
		default: "next",
	});
	export type MessageIntent = Static<typeof MessageIntent>;

	export const UserData = Type.Omit(AikitMessage.UserMessageSchema, ["messageId", "parts"]);
	export type UserData = Static<typeof UserData>;

	export const AssistantData = Type.Omit(AikitMessage.AssistantMessageSchema, ["messageId", "parts"]);
	export type AssistantData = Static<typeof AssistantData>;

	export const MessageData = Type.Union([UserData, AssistantData]);
	export type MessageData = Static<typeof MessageData>;

	export const TextPartData = AikitMessage.TextContentSchema;
	export const ImagePartData = AikitMessage.ImageContentSchema;
	export const ThinkingPartData = AikitMessage.ThinkingContentSchema;
	export const ToolCallPartData = AikitMessage.ToolCallSchema;

	export type TextPartData = Static<typeof TextPartData>;
	export type ImagePartData = Static<typeof ImagePartData>;
	export type ThinkingPartData = Static<typeof ThinkingPartData>;
	export type ToolCallPartData = Static<typeof ToolCallPartData>;

	export const PartData = Type.Union([TextPartData, ImagePartData, ThinkingPartData, ToolCallPartData]);
	export type PartData = Static<typeof PartData>;

	export const User = Type.Intersect(
		[
			Base,
			UserData,
			Type.Object({
				intent: MessageIntent,
			}),
		],
		{ $id: "UserMessage" },
	);
	export type User = Static<typeof User>;

	export const Assistant = Type.Intersect([Base, AssistantData], { $id: "AssistantMessage" });
	export type Assistant = Static<typeof Assistant>;

	export const Message = Type.Union([User, Assistant], { $id: "Message" });
	export type Message = Static<typeof Message>;

	export const Info = Message;
	export type Info = Message;

	export const TextPart = Type.Intersect([PartBase, TextPartData], { $id: "TextPart" });
	export const ImagePart = Type.Intersect([PartBase, ImagePartData], { $id: "ImagePart" });
	export const ThinkingPart = Type.Intersect([PartBase, ThinkingPartData], { $id: "ThinkingPart" });
	export const ToolCallPart = Type.Intersect([PartBase, ToolCallPartData], { $id: "ToolCallPart" });

	export type TextPart = Static<typeof TextPart>;
	export type ImagePart = Static<typeof ImagePart>;
	export type ThinkingPart = Static<typeof ThinkingPart>;
	export type ToolCallPart = Static<typeof ToolCallPart>;

	export const Part = Type.Union([TextPart, ImagePart, ThinkingPart, ToolCallPart]);
	export type Part = Static<typeof Part>;

	export const WithParts = Type.Object({
		message: Message,
		parts: Type.Array(Part),
	});
	export type WithParts = Static<typeof WithParts>;
}
