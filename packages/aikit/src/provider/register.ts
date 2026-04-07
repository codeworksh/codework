import anthropicProvider from "./providers/anthropic/index";
import { Stream } from "./stream";

const providerModules = [["providers/anthropic/index.ts", anthropicProvider]] as const;

for (const [path, provider] of providerModules) {
	Stream.registerProtocolProvider(provider, path);
}
