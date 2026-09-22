/**
 * One presentation and one rule set for every OAuth login, so a command behaves
 * the same whichever CLI runs it.
 *
 * Credentials differ per provider; what a user is shown does not. Each provider
 * narrows to an {@link OAuthSummary} — metadata only, never a token — and
 * everything downstream works from that.
 *
 * Output convention: the summary is the command's result and belongs on stdout,
 * alone, so `--json` stays parseable. Every notice here is progress, not result,
 * and belongs on stderr.
 */

export type OAuthProviderId = "openai-codex" | "github-copilot";

export const OAUTH_PROVIDER_LABELS: Record<OAuthProviderId, string> = {
	"openai-codex": "OpenAI Codex",
	"github-copilot": "GitHub Copilot",
};

export const oauthProviderLabel = (provider: OAuthProviderId): string => OAUTH_PROVIDER_LABELS[provider];

/** A stored login as the outside world sees it. */
export type OAuthSummary = {
	readonly provider: OAuthProviderId;
	/** Epoch millis, or 0 for a credential that does not expire. */
	readonly expires: number;
	readonly accountId?: string | undefined;
	readonly apiEndpoint?: string | undefined;
	readonly enterpriseUrl?: string | undefined;
	readonly availableModels?: number | undefined;
};

export const summarizeOpenAICodex = (credentials: {
	readonly accountId: string;
	readonly expires: number;
}): OAuthSummary => ({
	provider: "openai-codex",
	expires: credentials.expires,
	accountId: credentials.accountId,
});

export const summarizeGitHubCopilot = (credentials: {
	readonly expires: number;
	readonly apiEndpoint?: string | undefined;
	readonly enterpriseUrl?: string | undefined;
	readonly availableModelIds?: ReadonlyArray<string> | undefined;
}): OAuthSummary => ({
	provider: "github-copilot",
	expires: credentials.expires,
	...(credentials.apiEndpoint === undefined ? {} : { apiEndpoint: credentials.apiEndpoint }),
	...(credentials.enterpriseUrl === undefined ? {} : { enterpriseUrl: credentials.enterpriseUrl }),
	...(credentials.availableModelIds === undefined ? {} : { availableModels: credentials.availableModelIds.length }),
});

/** Render a summary. Tokens never appear in it. */
export function formatOAuthSummary(
	summary: OAuthSummary,
	options: { readonly json?: boolean | undefined } = {},
): string {
	if (options.json) {
		return `${JSON.stringify(
			{
				...summary,
				...(summary.expires === 0 ? {} : { expiresAt: new Date(summary.expires).toISOString() }),
			},
			null,
			2,
		)}\n`;
	}

	return `${[
		`Provider: ${oauthProviderLabel(summary.provider)}`,
		...(summary.accountId === undefined ? [] : [`Account: ${summary.accountId}`]),
		...(summary.enterpriseUrl === undefined ? [] : [`Enterprise: ${summary.enterpriseUrl}`]),
		...(summary.apiEndpoint === undefined ? [] : [`API endpoint: ${summary.apiEndpoint}`]),
		...(summary.availableModels === undefined ? [] : [`Available models: ${summary.availableModels}`]),
		`Expires: ${
			summary.expires === 0 ? "never (re-login on persistent 401s)" : new Date(summary.expires).toLocaleString()
		}`,
	].join("\n")}\n`;
}

export type OAuthNoticeKind = "saved" | "cleared" | "refreshed" | "missing";

/** `location` is a bare place — a file path, or "the server". */
export function oauthNotice(kind: OAuthNoticeKind, provider: OAuthProviderId, location: string): string {
	const label = oauthProviderLabel(provider);
	switch (kind) {
		case "saved":
			return `Saved ${label} credentials to ${location}`;
		case "cleared":
			return `Cleared ${label} credentials from ${location}`;
		case "refreshed":
			return `Refreshed ${label} credentials at ${location}`;
		case "missing":
			return `no ${label} credentials found at ${location}`;
	}
}

export type OAuthProviderFlags = {
	readonly openaiCodex?: boolean | undefined;
	readonly githubCopilot?: boolean | undefined;
};

export type OAuthFlagCheck = { ok: true; provider: OAuthProviderId } | { ok: false; message: string };

/** Resolve the provider from the two mutually exclusive flags. */
export function checkOAuthProvider(flags: OAuthProviderFlags): OAuthFlagCheck {
	const codex = flags.openaiCodex === true;
	const copilot = flags.githubCopilot === true;
	if (codex === copilot) {
		return { ok: false, message: "choose exactly one provider: --openai-codex or --github-copilot" };
	}
	return { ok: true, provider: codex ? "openai-codex" : "github-copilot" };
}

export type OAuthLoginFlags = {
	readonly device?: boolean | undefined;
	readonly enterprise?: string | undefined;
	readonly enableModels?: boolean | undefined;
};

/** A login option the chosen provider has no use for, when one was given. */
export function oauthLoginIssue(provider: OAuthProviderId, flags: OAuthLoginFlags): string | undefined {
	if (provider === "openai-codex" && (flags.enterprise !== undefined || flags.enableModels === true)) {
		return "--enterprise and --enable-models only apply to --github-copilot";
	}
	if (provider === "github-copilot" && flags.device === true) {
		return "GitHub Copilot always uses the device-code flow; --device is redundant";
	}
	return undefined;
}

/** Why a provider cannot be refreshed, when it cannot. */
export function oauthRefreshIssue(provider: OAuthProviderId): string | undefined {
	return provider === "github-copilot"
		? "GitHub Copilot tokens do not expire; sign in again on persistent 401s"
		: undefined;
}
