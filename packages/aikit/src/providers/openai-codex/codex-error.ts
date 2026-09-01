import { APICallError } from "@ai-sdk/provider";

type OpenAICodexError = {
	code?: string;
	type?: string;
	message?: string;
	plan_type?: string;
	resets_at?: number;
};

type OpenAICodexErrorPayload = {
	error?: OpenAICodexError;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const asString = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value.trim() : undefined;

function normalizeErrorPayload(value: unknown): OpenAICodexErrorPayload {
	const record = asRecord(value);
	const nested = asRecord(record?.error);
	const source = nested ?? record ?? {};
	const code = asString(source.code);
	const type = asString(source.type);
	const message = asString(source.message);
	const planType = asString(source.plan_type);
	const error: OpenAICodexError = {
		...(code !== undefined && { code }),
		...(type !== undefined && { type }),
		...(message !== undefined && { message }),
		...(planType !== undefined && { plan_type: planType }),
		...(typeof source.resets_at === "number" && { resets_at: source.resets_at }),
	};
	return { error };
}

function parseErrorPayload(body: string): OpenAICodexErrorPayload | undefined {
	try {
		return normalizeErrorPayload(JSON.parse(body) as unknown);
	} catch {
		return undefined;
	}
}

function errorIdentifiers(error: OpenAICodexError | undefined): string {
	return `${error?.code ?? ""} ${error?.type ?? ""}`.toLowerCase();
}

function hasIdentifier(error: OpenAICodexError | undefined, identifiers: readonly string[]): boolean {
	const value = errorIdentifiers(error);
	return identifiers.some((identifier) => value.includes(identifier));
}

function isUsageLimitError(error: OpenAICodexError | undefined): boolean {
	return hasIdentifier(error, ["usage_limit_reached", "gousagelimiterror", "freeusagelimiterror"]);
}

function isTerminalRateLimitError(body: string, payload = parseErrorPayload(body)): boolean {
	return (
		isUsageLimitError(payload?.error) ||
		hasIdentifier(payload?.error, ["usage_not_included", "insufficient_quota"]) ||
		/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|out of budget|quota exceeded|billing/i.test(
			body,
		)
	);
}

function streamErrorStatus(error: OpenAICodexError | undefined): number {
	if (isUsageLimitError(error) || hasIdentifier(error, ["usage_not_included", "insufficient_quota", "rate_limit"])) {
		return 429;
	}
	if (hasIdentifier(error, ["server_is_overloaded", "slow_down"])) return 503;
	if (
		hasIdentifier(error, [
			"context_length_exceeded",
			"invalid_prompt",
			"bio_policy",
			"cyber_policy",
			"misalignment_policy_violation",
		])
	) {
		return 400;
	}
	return 500;
}

function retryAfterHeader(message: string | undefined): Record<string, string> {
	const match = message?.match(/try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)/i);
	if (!match) return {};
	const value = Number(match[1]);
	if (!Number.isFinite(value)) return {};
	return { "retry-after": String(match[2]?.toLowerCase() === "ms" ? value / 1_000 : value) };
}

/**
 * Turn a Codex error payload into a human-friendly message. Only terminal
 * ChatGPT plan exhaustion is rewritten; transient 429s retain backend detail.
 */
export function openAICodexErrorMessage(_status: number, body: string, statusText?: string): string {
	let message = body || statusText || "OpenAI Codex request failed";
	const payload = parseErrorPayload(body);
	const error = payload?.error;

	if (isUsageLimitError(error)) {
		const plan = error?.plan_type ? ` (${error.plan_type.toLowerCase()} plan)` : "";
		const minutes = error?.resets_at
			? Math.max(0, Math.round((error.resets_at * 1000 - Date.now()) / 60000))
			: undefined;
		const when = minutes === undefined ? "" : ` Try again in ~${minutes} min.`;
		return `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
	}

	if (error?.message) message = error.message;
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
	const data = parseErrorPayload(responseBody);

	return new APICallError({
		message: openAICodexErrorMessage(response.status, responseBody, response.statusText),
		url,
		requestBodyValues,
		statusCode: response.status,
		responseHeaders,
		responseBody,
		...(data !== undefined && { data }),
		isRetryable:
			response.status === 408 ||
			response.status === 409 ||
			(response.status === 429 && !isTerminalRateLimitError(responseBody, data)) ||
			response.status >= 500,
	});
}

/** Map an error embedded in a successful SSE response to the same API error shape as HTTP failures. */
export function createOpenAICodexStreamError(args: {
	error: unknown;
	url: string;
	requestBodyValues: unknown;
	responseHeaders?: Record<string, string>;
}): APICallError {
	const { error: value, url, requestBodyValues } = args;
	const data = normalizeErrorPayload(value);
	const error = data.error;
	const statusCode = streamErrorStatus(error);
	const responseBody = JSON.stringify(data);
	const responseHeaders = {
		...args.responseHeaders,
		...retryAfterHeader(error?.message),
	};

	return new APICallError({
		message: openAICodexErrorMessage(statusCode, responseBody),
		url,
		requestBodyValues,
		statusCode,
		responseHeaders,
		responseBody,
		data,
		isRetryable:
			statusCode >= 500 || (hasIdentifier(error, ["rate_limit"]) && !isTerminalRateLimitError(responseBody, data)),
	});
}

/** A transport failure used when an SSE response ends without a terminal Responses event. */
export function createOpenAICodexPrematureCloseError(args: {
	url: string;
	requestBodyValues: unknown;
	responseHeaders?: Record<string, string>;
}): APICallError {
	return new APICallError({
		message: "OpenAI Codex stream closed before response.completed",
		url: args.url,
		requestBodyValues: args.requestBodyValues,
		...(args.responseHeaders !== undefined && { responseHeaders: args.responseHeaders }),
		isRetryable: true,
	});
}
