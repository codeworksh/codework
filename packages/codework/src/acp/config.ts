import type * as Acp from "@agentclientprotocol/sdk";
import { Model } from "@codeworksh/aikit";
import { ModelCatalog, Settings, type State } from "@codeworksh/harness/effect";
import { Effect, Option } from "effect";

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

/** The catalog a session in `hostDir` sees: generated entries plus its settings' `models`. */
const catalogFor = (hostDir: string | undefined) =>
	Effect.gen(function* () {
		const settings = yield* Settings.Service;
		return yield* ModelCatalog.effective((yield* settings.load(hostDir)).models);
	}).pipe(Effect.orElseSucceed((): Model.BuiltInModels => ({})));

/** The `model` and `thought_level` selectors for a session's current configuration. */
export const options = Effect.fn("ACP.config.options")(function* (
	selection: State.Configuration,
	hostDir: string | undefined,
) {
	const catalog = yield* catalogFor(hostDir);
	// Providers the harness has credentials for; the current model stays selectable even if not.
	const providers = yield* ModelCatalog.available(hostDir === undefined ? {} : { hostDir }).pipe(
		Effect.orElseSucceed(() => []),
	);

	const current = `${selection.provider}/${selection.model}`;
	const models = providers.flatMap((provider) =>
		Object.entries(provider.models).map(([id, info]) => ({
			value: `${provider.id}/${id}`,
			name: `${info.provider.name}: ${info.name}`,
		})),
	);
	if (!models.some((option) => option.value === current)) models.unshift({ value: current, name: current });

	const result: Array<Acp.SessionConfigOption> = [
		{ id: MODEL, name: "Model", category: "model", type: "select", currentValue: current, options: models },
	];

	const info = catalog[selection.provider]?.[selection.model];
	const levels = info === undefined ? [] : Model.getSupportedThinkingLevels(info);
	if (levels.some((level) => level !== "off")) {
		result.push({
			id: THOUGHT_LEVEL,
			name: "Thinking Effort",
			category: "thought_level",
			type: "select",
			currentValue: selection.thinkingLevel,
			options: levels.map((level) => ({ value: level, name: thinkingLabels[level] })),
		});
	}
	return result;
});

/** Whether a model is in the catalog a session in `hostDir` sees. */
export const known = Effect.fn("ACP.config.known")(function* (
	model: { readonly provider: string; readonly id: string },
	hostDir: string | undefined,
) {
	const catalog = yield* catalogFor(hostDir);
	return catalog[model.provider]?.[model.id] !== undefined;
});

export * as Config from "./config.ts";
