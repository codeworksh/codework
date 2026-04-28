import {CodeWorkSdk} from "./generated";
import {type Config} from "./generated/client"
import {createClient} from "./generated/client";

export { type Config as CodeWorkClientConfig, CodeWorkSdk as CodeWorkSdkClient };

export function createCodeWorkClient(config?: Config & { directory?: string; workspaceId?: string }) {
	if (!config?.fetch) {
		const customFetch: any = (req: any) => {
			req.timeout = false
			return fetch(req)
		}
		config = {
			...config,
			fetch: customFetch,
		}
	}

	if (config?.directory) {
		const isNonASCII = /[^\x00-\x7F]/.test(config.directory)
		const encodedDirectory = isNonASCII ? encodeURIComponent(config.directory) : config.directory
		config.headers = {
			...config.headers,
			"x-codework-directory": encodedDirectory,
		}
	}

	if (config?.workspaceId) {
		config.headers = {
			...config.headers,
			"x-codework-workspace": config.workspaceId,
		}
	}

	const client = createClient(config)
	return new CodeWorkSdk({ client })
}