import {
	APICallError,
	EmptyResponseBodyError,
	InvalidArgumentError,
	InvalidPromptError,
	InvalidResponseDataError,
	JSONParseError,
	LoadAPIKeyError,
	LoadSettingError,
	NoContentGeneratedError,
	NoSuchModelError,
	TypeValidationError,
	UnsupportedFunctionalityError,
} from "@ai-sdk/provider";
import { RetryError } from "ai";
import type { Failure } from "./failure/schema.ts";

export * from "./failure/schema.ts";

type Metadata = Omit<Failure, "_tag" | "reason">;

const record = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const nonEmptyString = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const normalizeMessage = (message: string): string => {
	const trimmed = message.trim().replace(/[.!?]+$/u, "");
	return trimmed.replace(/^[A-Za-z]+/u, (word) => word.toLowerCase());
};

const errorMessage = (error: unknown): string => {
	const value = record(error);
	const data = record(value?.data);
	if (value?.name === "ProtocolAuthError") {
		return normalizeMessage(nonEmptyString(data?.message) ?? "provider credentials are missing");
	}
	if (error instanceof Error) return normalizeMessage(nonEmptyString(error.message) ?? error.name);
	return normalizeMessage(nonEmptyString(error) ?? "the provider request failed for an unknown reason");
};

const isProtocolAuthError = (error: unknown): boolean => {
	const value = record(error);
	return value?.name === "ProtocolAuthError";
};

const errorCode = (data: unknown): string | undefined => {
	const top = record(data);
	const nested = record(top?.error);
	return (
		nonEmptyString(top?.code) ??
		nonEmptyString(top?.type) ??
		nonEmptyString(nested?.code) ??
		nonEmptyString(nested?.type)
	);
};

const header = (headers: Record<string, string> | undefined, name: string): string | undefined => {
	if (headers === undefined) return undefined;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected) return nonEmptyString(value);
	}
};

const retryAfter = (headers: Record<string, string> | undefined): number | undefined => {
	const value = header(headers, "retry-after");
	if (value === undefined) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
};

const apiMetadata = (error: APICallError): Metadata => {
	const code = errorCode(error.data);
	const data = record(error.data);
	const nested = record(data?.error);
	const structuredMessage = nonEmptyString(data?.message) ?? nonEmptyString(nested?.message);
	const message = normalizeMessage(
		structuredMessage ??
			(error.responseBody !== undefined && error.message.includes(error.responseBody)
				? `provider request failed${error.statusCode === undefined ? "" : ` with http ${error.statusCode}`}`
				: errorMessage(error)),
	);
	const requestId =
		header(error.responseHeaders, "x-request-id") ??
		header(error.responseHeaders, "request-id") ??
		header(error.responseHeaders, "cf-ray");
	const retryAfterMs = retryAfter(error.responseHeaders);
	return {
		message,
		retryable: error.isRetryable,
		...(error.statusCode === undefined ? {} : { status: error.statusCode }),
		...(code === undefined ? {} : { code }),
		...(requestId === undefined ? {} : { requestId }),
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
	};
};

const includes = (value: string | undefined, terms: ReadonlyArray<string>): boolean =>
	value !== undefined && terms.some((term) => value.toLowerCase().includes(term));

const fromAPICall = (error: APICallError): Failure => {
	const details = apiMetadata(error);
	if (includes(details.code, ["quota", "billing", "credit"])) return { _tag: "Quota", ...details };
	if (includes(details.code, ["content_filter", "content_policy", "safety"])) {
		return { _tag: "ContentPolicy", ...details };
	}
	if (error.statusCode === 401) return { _tag: "Authentication", reason: "invalid", ...details };
	if (error.statusCode === 403) return { _tag: "Authorization", ...details };
	if (error.statusCode === 404) return { _tag: "ModelUnavailable", ...details };
	if (error.statusCode === 408) return { _tag: "Timeout", ...details };
	if (error.statusCode === 429) return { _tag: "RateLimit", ...details };
	if (error.statusCode !== undefined && error.statusCode >= 500) return { _tag: "Unavailable", ...details };
	if (error.statusCode === undefined) return { _tag: "Transport", ...details };
	if (error.statusCode >= 400 && error.statusCode < 500) return { _tag: "InvalidRequest", ...details };
	return { _tag: "Unknown", ...details };
};

const resemblesTimeout = (error: unknown): boolean => {
	const value = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	return /timeout|timed out/i.test(value);
};

const resemblesTransportFailure = (error: unknown): boolean => {
	if (error instanceof TypeError) return true;
	const value = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	return /fetch|network|socket|connection|econn|dns/i.test(value);
};

/** Normalize AI SDK and provider exceptions without retaining request bodies, response bodies, or headers. */
export function normalize(error: unknown): Failure {
	if (RetryError.isInstance(error) && error.lastError !== undefined && error.lastError !== error) {
		return normalize(error.lastError);
	}
	if (LoadAPIKeyError.isInstance(error) || isProtocolAuthError(error)) {
		return { _tag: "Authentication", reason: "missing", message: errorMessage(error), retryable: false };
	}
	if (LoadSettingError.isInstance(error)) {
		return { _tag: "Configuration", message: errorMessage(error), retryable: false };
	}
	if (NoSuchModelError.isInstance(error)) {
		return { _tag: "ModelUnavailable", message: errorMessage(error), retryable: false };
	}
	if (APICallError.isInstance(error)) return fromAPICall(error);
	if (
		InvalidPromptError.isInstance(error) ||
		InvalidArgumentError.isInstance(error) ||
		UnsupportedFunctionalityError.isInstance(error)
	) {
		return { _tag: "InvalidRequest", message: errorMessage(error), retryable: false };
	}
	if (
		InvalidResponseDataError.isInstance(error) ||
		JSONParseError.isInstance(error) ||
		EmptyResponseBodyError.isInstance(error) ||
		NoContentGeneratedError.isInstance(error) ||
		TypeValidationError.isInstance(error)
	) {
		return { _tag: "InvalidResponse", message: errorMessage(error), retryable: false };
	}
	if (resemblesTimeout(error)) return { _tag: "Timeout", message: errorMessage(error), retryable: true };
	if (resemblesTransportFailure(error)) {
		return { _tag: "Transport", message: errorMessage(error), retryable: true };
	}
	return { _tag: "Unknown", message: errorMessage(error), retryable: false };
}

/** Best-effort compatibility for terminal messages written before structured failures existed. */
export function fromMessage(message: string): Failure {
	const normalized = normalizeMessage(message);
	if (/api key/i.test(normalized) && /missing|required|not set/i.test(normalized)) {
		return { _tag: "Authentication", reason: "missing", message: normalized, retryable: false };
	}
	if (/api key|credential|token/i.test(normalized) && /invalid|expired|unauthorized/i.test(normalized)) {
		return {
			_tag: "Authentication",
			reason: /expired/i.test(normalized) ? "expired" : "invalid",
			message: normalized,
			retryable: false,
		};
	}
	return { _tag: "Unknown", message: normalized, retryable: false };
}
