#!/usr/bin/env node
import { render } from "ink";
import { App } from "./app.tsx";
import { getConfigManager } from "./config.ts";
import { registry, resolveApiKey } from "./registry.ts";

export { getConfigManager } from "./config.ts";
export { getCredentialStore } from "./credentials.ts";
export { registry, resolveApiKey } from "./registry.ts";

/**
 * Returns the currently active configured model and provider (along with resolved credentials).
 * The agent receives this clean model/provider contract rather than knowing about TUI state or key inputs.
 */
export async function getActiveModel(): Promise<{
	provider: string;
	model: string;
	apiKey?: string | undefined;
} | null> {
	const config = await getConfigManager().load();
	if (!config) return null;
	const providerDef = registry.get(config.provider);
	const keyInfo = providerDef ? await resolveApiKey(providerDef) : undefined;
	return {
		provider: config.provider,
		model: config.model,
		apiKey: keyInfo?.key,
	};
}

export function runTui() {
	if (process.stdout.isTTY) {
		process.stdout.write("\x1b]11;#000000\x07\x1b[40m\x1b[2J\x1b[H");
	}

	const app = render(<App />, {
		alternateScreen: true,
	});

	const restore = () => {
		if (process.stdout.isTTY) {
			process.stdout.write("\x1b]111\x07\x1b[0m");
		}
	};

	app.waitUntilExit().then(restore, restore);
	process.on("exit", restore);

	return app;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""))) {
	runTui();
}
