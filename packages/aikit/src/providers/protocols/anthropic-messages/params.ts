import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources";
import type { Static, TSchema } from "typebox";
import type { Message } from "../../../message/message";
import { Model } from "../../../model/model";
import { sanitizeSurrogates } from "../../../utils/sanitize";
import { ReasoningLevelEnum } from "../../schema/options";
import { adjustMaxTokensForThinking } from "../runtime";
import { Options, type OptionsWithThinking } from "./options";
import { convertMessages, convertTools, getCacheControl } from "./transform";

export type BuildParams<
	TProtocol extends Model.KnownProtocolEnum = typeof Model.KnownProtocolEnum.anthropicMessages,
	S extends TSchema = TSchema,
> = (model: Model.TModel<TProtocol>, context: Message.Context, options: Static<S>) => MessageCreateParamsStreaming;

export const buildParams: BuildParams<typeof Model.KnownProtocolEnum.anthropicMessages, typeof Options> = (
	model,
	context,
	options,
) => {
	const cacheControl = options.cacheControl ?? getCacheControl(model.baseUrl, options.cacheRetention);

	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(context.messages, model, cacheControl),
		max_tokens: options.maxTokens || (model.maxTokens / 3) | 0,
		stream: true,
	};

	if (context.systemPrompt) {
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	if (options.temperature !== undefined && !options.thinkingEnabled) {
		params.temperature = options.temperature;
	}

	if (context.tools) {
		params.tools = convertTools(context.tools);
	}

	if (options.thinkingEnabled && model.reasoning) {
		params.thinking = {
			type: "enabled",
			budget_tokens: options.thinkingBudgetTokens || 1024,
		};
	}

	if (options.metadata) {
		const userId = options.metadata.user_id || options.metadata.userId;
		if (typeof userId === "string") {
			params.metadata = { user_id: userId };
		}
	}

	if (options.toolChoice) {
		params.tool_choice = typeof options.toolChoice === "string" ? { type: options.toolChoice } : options.toolChoice;
	}

	return params;
};

export const buildThinkingParams: BuildParams<
	typeof Model.KnownProtocolEnum.anthropicMessages,
	typeof OptionsWithThinking
> = (model, context, options) => {
	const base = {
		...options,
		maxTokens: options.maxTokens ?? Math.min(model.maxTokens, 32000),
		stream: true,
	};

	if (!options.reasoning || options.reasoning === ReasoningLevelEnum.off) {
		return buildParams(model, context, { ...base, thinkingEnabled: false });
	}

	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens || 0,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	return buildParams(model, context, {
		...base,
		maxTokens: adjusted.maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: adjusted.thinkingBudget,
	});
};
