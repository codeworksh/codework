import Anthropic from "@anthropic-ai/sdk";
import Type, { type Static } from "typebox";
import { Model } from "../../../model/model";
import { ReasoningLevel, SharedOptions, ThinkingBudgets } from "../../schema/options";
import { createObjectSchemaBuilder } from "../../schema/utils";

export const PROTOCOL = Model.KnownProtocolEnum.anthropicMessages;

export const CacheControl = Type.Object({
	type: Type.Union([Type.Literal("ephemeral")]),
	ttl: Type.Optional(Type.Union([Type.Literal("5m"), Type.Literal("1h")])),
});
export type CacheControl = Static<typeof CacheControl>;

const ToolChoice = Type.Union([
	Type.Literal("auto"),
	Type.Literal("any"),
	Type.Literal("none"),
	Type.Object({
		type: Type.Literal("tool"),
		name: Type.String(),
	}),
]);

export const Options = createObjectSchemaBuilder(SharedOptions)
	.withOption("client", Type.Optional(Type.Unsafe<InstanceType<typeof Anthropic>>({})))
	.withOptions({
		cacheControl: Type.Optional(CacheControl),
		thinkingEnabled: Type.Optional(Type.Boolean()),
		thinkingBudgetTokens: Type.Optional(Type.Number()),
		toolChoice: Type.Optional(ToolChoice),
	})
	.make();
export type Options = Static<typeof Options>;

export const OptionsWithThinking = createObjectSchemaBuilder(Options)
	/**
	 * Effort level for adaptive thinking (Opus 4.6+ and Sonnet 4.6).
	 * Controls how much thinking Claude allocates:
	 * - "max": Always thinks with no constraints (Opus 4.6 only)
	 * - "xhigh": Highest reasoning level (Opus 4.7)
	 * - "high": Always thinks, deep reasoning (default)
	 * - "medium": Moderate thinking, may skip for simple queries
	 * - "low": Minimal thinking, skips for simple tasks
	 * Ignored for older models.
	 */
	.withOption("reasoning", ReasoningLevel)
	/**
	 * Enable extended thinking.
	 * For Opus 4.6 and Sonnet 4.6: uses adaptive thinking (model decides when/how much to think).
	 * For older models: uses budget-based thinking with thinkingBudgetTokens.
	 */
	.withOption("thinkingEnabled", Type.Boolean())
	.withOption("thinkingBudgets", ThinkingBudgets)
	/**
	 * Token budget for extended thinking (older models only).
	 * Ignored for Opus 4.6 and Sonnet 4.6, which use adaptive thinking.
	 */
	.withOption("thinkingBudgetTokens", Type.Number())
	.make();
export type OptionsWithThinking = Static<typeof OptionsWithThinking>;
