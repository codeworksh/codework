import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import { llm, Model } from "@codeworksh/aikit";
import { JsonGitHubCopilotAuthStorage } from "@codeworksh/aikit/oauth/github/copilot";
import { JsonOpenAICodexAuthStorage } from "@codeworksh/aikit/oauth/openai/codex";
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

export const parseModelValue = (
	value: string,
	defaultProvider?: string,
): { provider: string; modelId: string } => {
	const slash = value.indexOf("/");
	if (slash !== -1) {
		return {
			provider: value.slice(0, slash),
			modelId: value.slice(slash + 1),
		};
	}
	return {
		provider: defaultProvider ?? "openai",
		modelId: value,
	};
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
		let provider: string;
		let modelId: string;

		if (input.provider !== undefined) {
			provider = input.provider;
			modelId = input.model ?? "gpt-5.6-luna";
		} else {
			const parsed = parseModelValue(input.model ?? "openai/gpt-5.6-luna");
			provider = parsed.provider;
			modelId = parsed.modelId;
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
			if (provider) {
				activeProviders.add(provider);
			}

			// Check OAuth availability
			const codexStorage = new JsonOpenAICodexAuthStorage({});
			const copilotStorage = new JsonGitHubCopilotAuthStorage({});
			const [hasCodex, hasCopilot] = yield* Effect.tryPromise(() =>
				Promise.all([
					codexStorage.get().then((token) => Boolean(token?.access)).catch(() => false),
					copilotStorage.get().then((token) => Boolean(token?.access)).catch(() => false),
				]),
			).pipe(Effect.orElseSucceed(() => [false, false] as const));

			if (hasCodex) activeProviders.add("openai-codex");
			if (hasCopilot) activeProviders.add("github-copilot");

			for (const [pId, pModels] of Object.entries(catalog)) {
				if (!pModels) continue;
				const first = Object.values(pModels)[0];
				const envVars = first?.provider?.env ?? [];
				// oxlint-disable-next-line effecttsgo/process-env
				const hasKey = envVars.some((k) => Boolean(process.env[k]));
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
