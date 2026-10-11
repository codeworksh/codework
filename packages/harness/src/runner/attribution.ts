/*
 * @file Default app-attribution headers per provider.
 *
 * Attribution identifies the calling app, not the transport, so it lives in the
 * harness rather than aikit. Defaults sit under the model's own headers, so any
 * configured header with the same name wins.
 */

import type { Model } from "@codeworksh/aikit";

const OPENROUTER_HOST = "openrouter.ai";

const isOpenRouter = (model: Model.Info): boolean =>
	model.provider.id === "openrouter" || (model.api?.url ?? model.baseUrl).includes(OPENROUTER_HOST);

const defaults = (model: Model.Info): Record<string, string> | undefined =>
	isOpenRouter(model)
		? {
				"HTTP-Referer": "https://codework.sh",
				"X-OpenRouter-Title": "CodeWork",
				"X-OpenRouter-Categories": "cli-agent,personal-agent",
			}
		: undefined;

export const withAttribution = (model: Model.Info): Model.Info => {
	const headers = defaults(model);
	return headers === undefined ? model : { ...model, headers: { ...headers, ...model.headers } };
};

export * as Attribution from "./attribution.ts";
