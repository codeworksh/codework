import type * as Acp from "@codeworksh/acp/schema-v1";
import { Model } from "@codeworksh/aikit";
import { JsonGitHubCopilotAuthStorage } from "@codeworksh/aikit/oauth/github/copilot";
import { JsonOpenAICodexAuthStorage } from "@codeworksh/aikit/oauth/openai/codex";
import { ModelCatalog } from "@codeworksh/harness/effect";
import { Effect, Option } from "effect";

/** The model and thinking level a session runs with, as the ACP layer last set them. */
export interface Selection {
	readonly provider: string;
	readonly id: string;
	readonly thinkingLevel: Model.ThinkingLevel;
}

export const MODEL = "model";
export const THOUGHT_LEVEL = "thought_level";

const thinkingLabels: Record<Model.ThinkingLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra High",
	max: "Max",
};

export const isThinkingLevel = (value: string): value is Model.ThinkingLevel => Object.hasOwn(thinkingLabels, value);

/** Splits a `provider/model` option value on its first slash; model ids may contain more. */
export const parseModel = (value: string): Option.Option<{ readonly provider: string; readonly id: string }> => {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return Option.none();
	return Option.some({ provider: value.slice(0, slash), id: value.slice(slash + 1) });
};

const loggedIn = (provider: string, token: () => Promise<{ readonly access?: string } | undefined>) =>
	Effect.tryPromise(token).pipe(
		Effect.map((stored) => (stored?.access ? [provider] : [])),
		Effect.orElseSucceed(() => []),
	);

const oauthProviders = Effect.map(
	Effect.all(
		[
			loggedIn("openai-codex", () => new JsonOpenAICodexAuthStorage({}).get()),
			loggedIn("github-copilot", () => new JsonGitHubCopilotAuthStorage({}).get()),
		],
		{ concurrency: "unbounded" },
	),
	(providers) => providers.flat(),
);

/**
 * Providers with credentials: an API key in the environment or an OAuth login.
 * A harness "usable models" query replaces this (COD-83).
 */
const usableProviders = (catalog: Model.BuiltInModels) =>
	Effect.map(oauthProviders, (oauth) => {
		const withKeys = Object.entries(catalog).flatMap(([provider, models]) => {
			const env = Object.values(models ?? {})[0]?.provider.env ?? [];
			// oxlint-disable-next-line effecttsgo/process-env
			return env.some((name) => Boolean(process.env[name])) ? [provider] : [];
		});
		return new Set([...withKeys, ...oauth]);
	});

/** The `model` and `thought_level` selectors for a session's current selection. */
export const options = Effect.fn("ACP.config.options")(function* (selection: Selection) {
	const catalog = yield* ModelCatalog.models.pipe(Effect.orElseSucceed((): Model.BuiltInModels => ({})));
	const providers = yield* usableProviders(catalog);
	providers.add(selection.provider);

	const current = `${selection.provider}/${selection.id}`;
	const models = [...providers].flatMap((provider) =>
		Object.entries(catalog[provider] ?? {}).map(([id, info]) => ({
			value: `${provider}/${id}`,
			name: `${info.provider.name}: ${info.name}`,
		})),
	);
	if (!models.some((option) => option.value === current)) models.unshift({ value: current, name: current });

	const result: Array<Acp.SessionConfigOption> = [
		{ id: MODEL, name: "Model", category: "model", type: "select", currentValue: current, options: models },
	];

	const info = catalog[selection.provider]?.[selection.id];
	const levels = info === undefined || info.reasoning === false ? [] : Model.getSupportedThinkingLevels(info);
	if (levels.some((level) => level !== "off")) {
		result.push({
			id: THOUGHT_LEVEL,
			name: "Thinking Effort",
			category: "thought_level",
			type: "select",
			currentValue: levels.includes(selection.thinkingLevel) ? selection.thinkingLevel : (levels[0] ?? "off"),
			options: levels.map((level) => ({ value: level, name: thinkingLabels[level] })),
		});
	}
	return result;
});

/** Whether `value` names a model in the catalog. */
export const known = Effect.fn("ACP.config.known")(function* (model: {
	readonly provider: string;
	readonly id: string;
}) {
	const catalog = yield* ModelCatalog.models.pipe(Effect.orElseSucceed((): Model.BuiltInModels => ({})));
	return catalog[model.provider]?.[model.id] !== undefined;
});

export * as Config from "./config.ts";
