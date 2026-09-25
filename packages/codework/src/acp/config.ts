import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import { llm, Model } from "@codeworksh/aikit";
import { ModelCatalog } from "@codeworksh/harness/effect";
import { Effect } from "effect";

export const formatThinkingLevel = (level: Model.ThinkingLevel): string => {
	switch (level) {
		case "off":
			return "Off";
		case "minimal":
			return "Minimal";
		case "low":
			return "Low";
		case "medium":
			return "Medium";
		case "high":
			return "High";
		case "xhigh":
			return "Extra High";
		case "max":
			return "Max";
	}
};

export interface SessionConfigInput {
	readonly provider?: string | undefined;
	readonly model?: string | undefined;
	readonly thinkingLevel?: Model.ThinkingLevel | undefined;
}

/**
 * Resolves ACP session configuration options for the active session.
 *
 * Discovers available models and model-specific thinking levels, exporting:
 * - `model` (category: "model") allowing clients like Zed IDE to render the model dropdown selector.
 * - `thought_level` (category: "thought_level") allowing clients like Zed IDE to render the thinking effort selector.
 */
export const resolveConfigOptions = (input: SessionConfigInput): Effect.Effect<Array<SessionConfigOption>> =>
	Effect.gen(function* () {
		let provider = input.provider ?? "openai";
		let modelId = input.model ?? "gpt-5.6-luna";
		if (modelId.includes("/")) {
			const slash = modelId.indexOf("/");
			provider = input.provider ?? modelId.slice(0, slash);
			modelId = modelId.slice(slash + 1);
		}

		const modelInfo = yield* Effect.tryPromise(() => llm.model(provider, modelId)).pipe(
			Effect.orElseSucceed(() => undefined),
		);

		const options: Array<SessionConfigOption> = [];

		// 1. Model selection option
		const currentModelValue = `${provider}/${modelId}`;
		const catalog = yield* ModelCatalog.models.pipe(Effect.orElseSucceed(() => undefined));

		const modelOptions: Array<SessionConfigSelectOption> = [];

		if (catalog) {
			const activeProviders = new Set<string>();
			activeProviders.add(provider);
			activeProviders.add("google");
			activeProviders.add("openai");
			activeProviders.add("anthropic");

			for (const [pId, pModels] of Object.entries(catalog)) {
				if (!pModels) continue;
				const first = Object.values(pModels)[0];
				const envVars = first?.provider?.env ?? [];
				const hasKey = envVars.some((k) => {
					const proc = (globalThis as Record<string, unknown>).process as
						| { env?: Record<string, string | undefined> }
						| undefined;
					return Boolean(proc?.env?.[k]);
				});
				if (hasKey) {
					activeProviders.add(pId);
				}
			}

			for (const pId of activeProviders) {
				const pModels = catalog[pId];
				if (!pModels) continue;
				for (const [mId, mInfo] of Object.entries(pModels)) {
					modelOptions.push({
						value: `${pId}/${mId}`,
						name: `${mInfo.provider.name}: ${mInfo.name}`,
					});
				}
			}
		}

		if (modelOptions.length === 0) {
			modelOptions.push(
				{ value: "google/gemini-2.5-pro", name: "Google: Gemini 2.5 Pro" },
				{ value: "google/gemini-2.5-flash", name: "Google: Gemini 2.5 Flash" },
				{ value: "google/gemini-3.8-flash", name: "Google: Gemini 3.8 Flash" },
				{ value: "openai/gpt-5.6-luna", name: "OpenAI: GPT-5.6 Luna" },
				{ value: "openai/gpt-4o", name: "OpenAI: GPT-4o" },
				{ value: "anthropic/claude-3-7-sonnet", name: "Anthropic: Claude 3.7 Sonnet" },
			);
		}

		if (!modelOptions.some((o) => o.value === currentModelValue)) {
			modelOptions.unshift({
				value: currentModelValue,
				name: `${provider}: ${modelId}`,
			});
		}

		options.push({
			id: "model",
			name: "Model",
			type: "select",
			category: "model",
			currentValue: currentModelValue,
			options: modelOptions,
		});

		// 2. Thinking effort option
		const supported = modelInfo
			? Model.getSupportedThinkingLevels(modelInfo)
			: [
					Model.ThinkingLevelEnum.off,
					Model.ThinkingLevelEnum.low,
					Model.ThinkingLevelEnum.medium,
					Model.ThinkingLevelEnum.high,
				];

		const reasoningSupported = modelInfo ? modelInfo.reasoning !== false : true;
		if (reasoningSupported && supported.length > 0 && !(supported.length === 1 && supported[0] === "off")) {
			const current = input.thinkingLevel ?? Model.ThinkingLevelEnum.high;
			const currentValue = supported.includes(current) ? current : (supported[0] ?? Model.ThinkingLevelEnum.off);

			options.push({
				id: "thought_level",
				name: "Thinking Effort",
				type: "select",
				category: "thought_level",
				currentValue,
				options: supported.map((level) => ({
					value: level,
					name: formatThinkingLevel(level),
				})),
			});
		}

		return options;
	});

export * as Config from "./config.ts";
