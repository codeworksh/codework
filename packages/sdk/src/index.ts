import { createClient, type Config } from "./generated/client/index.ts";
import { CodeWorkSdk } from "./generated/index.ts";

export * from "./generated/index.ts";
export { createClient };
export type { Client, Config } from "./generated/client/index.ts";

export type CodeWorkClientOptions = Omit<Config, "baseUrl" | "headers"> & {
	baseUrl: string;
	directory?: string;
	headers?: HeadersInit;
	workspaceId?: string;
};

function codeWorkHeaders(options: Pick<CodeWorkClientOptions, "directory" | "headers" | "workspaceId">) {
	const headers = new Headers(options.headers);

	if (options.directory) {
		headers.set("x-codework-directory", encodeURIComponent(options.directory));
	}

	if (options.workspaceId) {
		headers.set("x-codework-workspace", options.workspaceId);
	}

	return headers;
}

export function createCodeWorkClient(options: CodeWorkClientOptions) {
	const { directory, headers, workspaceId, ...config } = options;

	return new CodeWorkSdk({
		client: createClient({
			...config,
			headers: codeWorkHeaders({ directory, headers, workspaceId }),
		}),
	});
}
