export {
	GITHUB_COPILOT_DEFAULT_BASE_URL,
	GITHUB_COPILOT_PROVIDER_NAME,
	createGitHubCopilot,
	githubCopilot,
} from "./copilot-provider.ts";
export type { GitHubCopilotProvider, GitHubCopilotProviderSettings } from "./copilot-provider.ts";
export { createCopilotFetch } from "./copilot-fetch.ts";
export type { CopilotFetchOptions, GitHubCopilotApiKey } from "./copilot-fetch.ts";
export {
	GITHUB_COPILOT_API_VERSION,
	GITHUB_COPILOT_STATIC_HEADERS,
	applyCopilotHeaders,
	copilotRequestMetadata,
} from "./copilot-headers.ts";
export type { GitHubCopilotInteractionType } from "./copilot-headers.ts";
