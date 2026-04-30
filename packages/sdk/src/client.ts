import { CodeWorkSdk } from "./generated";
import { createClient, createConfig, type Config } from "./generated/client";

export { type Config, CodeWorkSdk as CodeWorkSdkClient };

export interface CodeWorkClientConfig extends Config {
	directory?: string;
	workspaceId?: string;
}

export function createCodeWorkClient(config: CodeWorkClientConfig) {
	const { directory, workspaceId, ...clientConfig } = config;
	const headers = new Headers(clientConfig.headers as HeadersInit);

	if (directory) {
		headers.set("x-codework-directory", encodeURIComponent(directory));
	}

	if (workspaceId) {
		headers.set("x-codework-workspace", workspaceId);
	}

	const customFetch: typeof fetch = (request, init) => {
		if (request instanceof Request) (request as Request & { timeout?: boolean }).timeout = false;
		return fetch(request, init);
	};

	const client = createClient({
		...createConfig(clientConfig),
		fetch: clientConfig.fetch ?? customFetch,
		headers,
	});
	return new CodeWorkSdk({ client });
}
