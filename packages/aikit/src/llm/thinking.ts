/*
 * @file How a thinking level becomes a budget, a ceiling, and provider options.
 *
 * Every provider spells reasoning differently -- an effort string, a token budget,
 * a level -- but they all draw from the same two numbers, and those two numbers
 * are decided together because the budget and the answer share one ceiling.
 */

import * as Message from "../message/message.ts";
import * as Model from "../model/model.ts";
import type { ProviderOptionBag, RuntimeOptions } from "./options.ts";
import {
	adjustMaxTokensForThinking,
	clampMaxTokensToContext,
	clampThinkingBudgetToAnswerRoom,
	thinkingBudgetForLevel,
} from "./shared.ts";

/**
 * The thinking budget and response ceiling for one request, resolved together.
 *
 * A budget and the answer share `model.maxTokens`, so neither can be decided
 * alone. `maxTokens` is what the request should ask for; `budget` is what fits
 * inside it once the answer keeps its floor.
 */
export interface Plan {
	readonly level: Model.ThinkingLevel;
	/** Fitted tokens, or Google's -1 sentinel for provider-managed dynamic thinking. */
	readonly budget: number;
	readonly maxTokens: number | undefined;
	/** The caller configured a budget for this level, rather than inheriting a default. */
	readonly explicit: boolean;
}

/** Anthropic rejects an enabled thinking block whose budget is under 1024 tokens. */
const ANTHROPIC_MIN_THINKING_BUDGET = 1024;

/**
 * The smallest budget this model will accept, for providers that take one at all.
 *
 * Adaptive models are exempt: they are sent an effort level and no budget, so
 * there is no floor to fall under.
 */
function minimumThinkingBudget(model: Model.Info): number {
	const key = Model.optionsKey(model);
	if (key !== "anthropic" && key !== "google-vertex-anthropic") return 0;
	return model.compat?.forceAdaptiveThinking ? 0 : ANTHROPIC_MIN_THINKING_BUDGET;
}

export function resolvePlan(model: Model.Info, context: Message.Context, options: RuntimeOptions): Plan {
	const clampToContext = (maxTokens: number | undefined) =>
		maxTokens === undefined ? undefined : clampMaxTokensToContext(model, context, maxTokens);

	const requested = options.reasoning;
	const level = requested ? Model.clampThinkingLevel(model, requested) : "off";
	if (level === "off") return { level, budget: 0, maxTokens: clampToContext(options.maxTokens), explicit: false };

	const budgets = options.thinkingBudgets;
	const explicit = budgets?.[level] !== undefined;
	const key = Model.optionsKey(model);
	const usesGoogleBudget = (key === "google" || key === "google-vertex") && !usesGoogleThinkingLevel(model);
	const requestedBudget = usesGoogleBudget
		? (budgets?.[level] ?? googleThinkingBudget(model, googleThinkingLevel(model.thinkingLevelMap?.[level] ?? level)))
		: thinkingBudgetForLevel(level, budgets);

	// A catalog entry without a ceiling gives the fit nothing to work against.
	if (model.maxTokens <= 0) {
		return { level, budget: requestedBudget, maxTokens: clampToContext(options.maxTokens), explicit };
	}

	// Google's -1 is a dynamic-thinking sentinel, not a negative token count.
	const dynamic = usesGoogleBudget && requestedBudget === -1;
	const adjusted = adjustMaxTokensForThinking(options.maxTokens, model.maxTokens, level, {
		[level]: dynamic ? 0 : requestedBudget,
	});
	const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);

	/*
	 * Preserve an explicit small answer allowance when it fits, and apply the
	 * 1024-token reserve when context pressure reduces it. Pi's Anthropic wrapper
	 * applies this reserve unconditionally; aikit deliberately permits small answers.
	 */
	const budget =
		maxTokens < adjusted.maxTokens
			? clampThinkingBudgetToAnswerRoom(adjusted.thinkingBudget, maxTokens)
			: adjusted.thinkingBudget;

	/*
	 * A budget below the provider's own floor is not a smaller amount of thinking,
	 * it is an invalid request. When the room has gone -- a nearly full window is
	 * the way there -- the turn goes out without thinking rather than not at all.
	 */
	if (budget < minimumThinkingBudget(model)) {
		return { level: "off", budget: 0, maxTokens, explicit };
	}

	return { level, budget: dynamic ? -1 : budget, maxTokens, explicit };
}

type GoogleThinkingLevel = "minimal" | "low" | "medium" | "high";

/** Families that take `thinkingLevel` and reject a token budget. */
function usesGoogleThinkingLevel(model: Model.Info): boolean {
	const id = model.id.toLowerCase();
	return (
		/gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id) ||
		/gemma-?4/.test(id) ||
		id === "gemini-flash-latest" ||
		id === "gemini-flash-lite-latest"
	);
}

function googleThinkingLevel(mapped: string): GoogleThinkingLevel {
	return mapped === "xhigh" || mapped === "max" ? "high" : (mapped as GoogleThinkingLevel);
}

/** Per-family budgets. `-1` asks Gemini to size thinking dynamically. */
const GOOGLE_THINKING_BUDGETS: ReadonlyArray<[RegExp, Record<GoogleThinkingLevel, number>]> = [
	[/2\.5-pro/, { minimal: 128, low: 2048, medium: 8192, high: 32768 }],
	[/2\.5-flash-lite/, { minimal: 512, low: 2048, medium: 8192, high: 24576 }],
	[/2\.5-flash/, { minimal: 128, low: 2048, medium: 8192, high: 24576 }],
];

function googleThinkingBudget(model: Model.Info, level: GoogleThinkingLevel): number {
	for (const [pattern, budgets] of GOOGLE_THINKING_BUDGETS) {
		if (pattern.test(model.id)) return budgets[level];
	}
	return -1;
}

/**
 * Turn thinking off, in the provider's own words.
 *
 * Several models reason by default, so declining to *ask* for thinking is not the
 * same as asking for none: the caller ends up paying output tokens for reasoning
 * they never requested.
 *
 * OpenRouter is deliberately left alone. It fronts hundreds of third-party
 * endpoints whose support varies per endpoint -- several reject the request
 * outright with "reasoning is mandatory for this endpoint and cannot be disabled"
 * -- so its reasoning stays pass-through.
 */
export function disabledProviderOptions(model: Model.Info): ProviderOptionBag {
	// A model that cannot reason has nothing to switch off.
	if (!model.reasoning) return {};

	const key = Model.optionsKey(model);

	if (key === "anthropic" || key === "google-vertex-anthropic") {
		return { [key]: { thinking: { type: "disabled" } } };
	}

	if (key === "google" || key === "google-vertex") {
		return { [key]: { thinkingConfig: googleDisabledThinkingConfig(model) } };
	}

	if (key === "openai" || key === "xai" || key === "openai-codex") {
		const off = model.thinkingLevelMap?.off;
		// `null` means this model cannot disable reasoning; sending an effort it
		// does not accept would fail the request outright.
		if (off === null) return {};
		return { [key]: { reasoningEffort: off ?? "none" } };
	}

	return {};
}

/**
 * Gemini 3 Pro cannot disable thinking, and Gemini 3 Flash and Gemma 4 cannot
 * fully disable it either. For those, ask for the lowest level and leave
 * `includeThoughts` off so the thinking stays hidden. Gemini 2.x takes a zero budget.
 */
function googleDisabledThinkingConfig(model: Model.Info): Record<string, unknown> {
	const id = model.id.toLowerCase();
	if (/gemini-3(?:\.\d+)?-pro/.test(id)) return { thinkingLevel: "low" };
	if (usesGoogleThinkingLevel(model)) return { thinkingLevel: "minimal" };
	return { thinkingBudget: 0 };
}

type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The effort level an adaptive Claude model reasons at.
 *
 * A model's own `thinkingLevelMap` wins where it has an opinion -- that is where
 * per-model support for `xhigh` and `max` is recorded -- and the rest collapse onto
 * the three levels every adaptive model accepts.
 */
function anthropicEffort(model: Model.Info, level: Model.ActiveThinkingLevel): AnthropicEffort {
	const mapped = model.thinkingLevelMap?.[level];
	if (typeof mapped === "string") return mapped as AnthropicEffort;

	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "xhigh":
			return "xhigh";
		case "max":
			return "max";
		default:
			return "high";
	}
}

export function reasoningProviderOptions(model: Model.Info, plan: Plan): ProviderOptionBag {
	const level = plan.level;
	if (level === "off") return disabledProviderOptions(model);

	const mapped = model.thinkingLevelMap?.[level] ?? level;
	if (!mapped) return {};

	const key = Model.optionsKey(model);
	const budget = plan.budget;

	if (key === "openai" || key === "xai" || key === "openai-codex") {
		return { [key]: { reasoningEffort: mapped } };
	}

	if (key === "openrouter") {
		return {
			[key]: {
				reasoning: {
					effort: mapped === "off" ? "none" : mapped,
				},
			},
		};
	}

	if (key === "google" || key === "google-vertex") {
		const thinkingLevel = googleThinkingLevel(mapped);
		// Gemini 3 and Gemma 4 take a level; earlier families take a token budget.
		if (usesGoogleThinkingLevel(model)) {
			return { [key]: { thinkingConfig: { thinkingLevel, includeThoughts: true } } };
		}
		return {
			[key]: {
				thinkingConfig: {
					includeThoughts: true,
					thinkingBudget: budget,
				},
			},
		};
	}

	if (key === "anthropic" || key === "google-vertex-anthropic") {
		// Newer Claude models size their own thinking from an effort level. Handing
		// them a fixed budget pins every turn to one depth instead.
		if (model.compat?.forceAdaptiveThinking) {
			return {
				[key]: {
					thinking: { type: "adaptive", display: "summarized" },
					effort: anthropicEffort(model, level),
				},
			};
		}

		return {
			[key]: {
				thinking: {
					type: "enabled",
					// Already fitted under `plan.maxTokens` with the answer floor reserved.
					// Re-clamping here would reserve that floor a second time.
					budgetTokens: budget,
				},
			},
		};
	}

	return {};
}

export * as Thinking from "./thinking.ts";
