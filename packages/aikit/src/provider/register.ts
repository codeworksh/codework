import { Stream } from "./stream";

type ProviderModule = {
	default: Stream.ProtocolProvider;
};

const providerModules = new Bun.Glob("providers/*/index.ts");
const providerBaseUrl = new URL("./", import.meta.url);

for (const path of providerModules.scanSync(import.meta.dir)) {
	const mod = (await import(new URL(path, providerBaseUrl).href)) as ProviderModule;
	if (!mod?.default) continue;
	Stream.registerProtocolProvider(mod.default, path);
}
