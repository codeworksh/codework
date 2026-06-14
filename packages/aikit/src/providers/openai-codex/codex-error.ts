import { APICallError } from "@ai-sdk/provider";

type OpenAICodexErrorPayload = {
	error?: {
		code?: string;
		type?: string;
		message?: string;
		plan_type?: string;
		resets_at?: number;
	};
};

/**
 * Turn a Codex error payload into a human-friendly message. ChatGPT plan usage
 * limits deserve a clearer message than the raw backend error.
 */
export function openAICodexErrorMessage(status: number, body: string, statusText?: string): string {
	let message = body || statusText || "OpenAI Codex request failed";

	try {
		const parsed = JSON.parse(body) as OpenAICodexErrorPayload;
		const error = parsed?.error;
		if (error) {
			const code = error.code ?? error.type ?? "";
			if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || status === 429) {
				const plan = error.plan_type ? ` (${error.plan_type.toLowerCase()} plan)` : "";
				const minutes = error.resets_at
					? Math.max(0, Math.round((error.resets_at * 1000 - Date.now()) / 60000))
					: undefined;
				const when = minutes === undefined ? "" : ` Try again in ~${minutes} min.`;
				return `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
			}
			message = error.message || message;
		}
	} catch {
		// Not JSON; keep the raw body as the message.
	}

	return message;
}

export async function createOpenAICodexAPICallError(args: {
	response: Response;
	url: string;
	requestBodyValues: unknown;
}): Promise<APICallError> {
	const { response, url, requestBodyValues } = args;
	const responseBody = await response.text().catch(() => "");
	const responseHeaders: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		responseHeaders[key] = value;
	});

	return new APICallError({
		message: openAICodexErrorMessage(response.status, responseBody, response.statusText),
		url,
		requestBodyValues,
		statusCode: response.status,
		responseHeaders,
		responseBody,
		isRetryable: response.status === 408 || response.status === 409 || response.status >= 500,
	});
}
