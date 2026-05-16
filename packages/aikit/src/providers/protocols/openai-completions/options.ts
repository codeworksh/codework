import { Model } from "../../../model/model";
import Type, { type Static } from "typebox";
import { ReasoningLevel, ReasoningLevelEnum, SharedOptions, ThinkingBudgets } from "../../schema/options";
import { createObjectSchemaBuilder } from "../../schema/utils";
import OpenAI from "openai";

export const PROTOCOL = Model.KnownProtocolEnum.openaiCompletions;

const ToolChoice = Type.Union([
	Type.Literal("auto"),
	Type.Literal("none"),
	Type.Literal("required"),
	Type.Object({
		type: Type.Literal("function"),
		function: Type.Object({ name: Type.String() }),
	}),
]);

const ReasoningLevelNoOff = Type.Exclude(ReasoningLevel, Type.Literal(ReasoningLevelEnum.off));
const ReasoningEffort = Type.Intersect([ReasoningLevelNoOff, Type.Literal("none")]);
type ReasoningEffort = Static<typeof ReasoningEffort>;

export const Options = createObjectSchemaBuilder(SharedOptions)
	.withOption("client", Type.Optional(Type.Unsafe<InstanceType<typeof OpenAI>>({})))
	.withOptions({
		store: Type.Optional(Type.Boolean()),
		/**
		 * Number between -2.0 and 2.0. Positive values penalize new tokens based on their
		 * existing frequency in the text so far, decreasing the model's likelihood to
		 * repeat the same line verbatim.
		 */
		frequencyPenalty: Type.Optional(Type.Number()),
		/**
		 * Number between -2.0 and 2.0. Positive values penalize new tokens based on
		 * whether they appear in the text so far, increasing the model's likelihood to
		 * talk about new topics.
		 */
		presencePenalty: Type.Optional(Type.Number()),
		/**
		 * Used by OpenAI to cache responses for similar requests to optimize your cache
		 * hit rates. Replaces the `user` field.
		 * [Learn more](https://platform.openai.com/docs/guides/prompt-caching).
		 */
		promptCacheKey: Type.Optional(Type.String()),
		/**
		 * The retention policy for the prompt cache. Set to `24h` to enable extended
		 * prompt caching, which keeps cached prefixes active for longer, up to a maximum
		 * of 24 hours.
		 * [Learn more](https://platform.openai.com/docs/guides/prompt-caching#prompt-cache-retention).
		 */
		promptCacheRetention: Type.Optional(Type.Union([Type.Literal("in-memory"), Type.Literal("24h"), Type.Null()])),
		seed: Type.Optional(Type.Number()),
		toolChoice: Type.Optional(ToolChoice),
		reasoningEffort: Type.Optional(ReasoningEffort),
	})
	.make();
export type Options = Static<typeof Options>;

export const OptionsWithThinking = createObjectSchemaBuilder(Options)
	.withOption("thinkingBudgets", ThinkingBudgets)
	.make();
export type OptionsWithThinking = Static<typeof OptionsWithThinking>;
