import { Schema } from "effect";
import { SandboxInstance } from "./instance.ts";

/**
 * Lifecycle errors are confined to the control plane. Once a mount succeeds,
 * consumers continue to see only FileSystemError and ShellError.
 */
export class SandboxNotFoundError extends Schema.TaggedError<SandboxNotFoundError>()("SandboxNotFoundError", {
	id: SandboxInstance.ID,
}) {}

export class SandboxDriverNotRegisteredError extends Schema.TaggedError<SandboxDriverNotRegisteredError>()(
	"SandboxDriverNotRegisteredError",
	{
		driver: Schema.String,
	},
) {}

export class SandboxDriverRegistrationError extends Schema.TaggedError<SandboxDriverRegistrationError>()(
	"SandboxDriverRegistrationError",
	{
		driver: Schema.String,
		reason: Schema.String,
	},
) {}

export class SandboxBusyError extends Schema.TaggedError<SandboxBusyError>()("SandboxBusyError", {
	id: SandboxInstance.ID,
	refCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

export class SandboxMustBeStoppedError extends Schema.TaggedError<SandboxMustBeStoppedError>()(
	"SandboxMustBeStoppedError",
	{
		id: SandboxInstance.ID,
		status: SandboxInstance.Status,
	},
) {}

export class SandboxRemovedError extends Schema.TaggedError<SandboxRemovedError>()("SandboxRemovedError", {
	id: SandboxInstance.ID,
	removedAt: Schema.optional(Schema.DateTimeUtc),
}) {}

export class SandboxUnavailError extends Schema.TaggedError<SandboxUnavailError>()("SandboxUnavailError", {
	id: SandboxInstance.ID,
	reason: Schema.String,
}) {}

export class SandboxUnsupportedError extends Schema.TaggedError<SandboxUnsupportedError>()("SandboxUnsupportedError", {
	id: SandboxInstance.ID,
	driver: Schema.String,
	operation: Schema.String,
}) {}

export class SandboxTransitionConflictError extends Schema.TaggedError<SandboxTransitionConflictError>()(
	"SandboxTransitionConflictError",
	{
		id: SandboxInstance.ID,
		expected: Schema.Array(SandboxInstance.Status),
		actual: SandboxInstance.Status,
	},
) {}

/**
 * A lifecycle failure safe to serialize, persist, or log.
 *
 * The raw SDK defect is deliberately absent from the schema. It is retained on
 * a non-enumerable symbol by {@link providerError}, so Effect's default
 * formatting and JSON serialization cannot expose credentials nested in it.
 */
export class SandboxProviderError extends Schema.TaggedError<SandboxProviderError>()("SandboxProviderError", {
	driver: Schema.String,
	operation: Schema.String,
	sanitized: SandboxInstance.PersistedError,
}) {}

const rawCause = Symbol("@codework/sandbox/provider/error/raw/cause");
const missingResource = Symbol("@codework/sandbox/provider/error/missing/resource");

export const providerErrorCause = (error: SandboxProviderError): unknown =>
	(error as SandboxProviderError & { readonly [rawCause]?: unknown })[rawCause];

export const providerErrorIsNotFound = (error: SandboxProviderError): boolean =>
	(error as SandboxProviderError & { readonly [missingResource]?: boolean })[missingResource] === true;

export type Redactor = (value: string) => string;

const REDACTED = "<redacted>";

/**
 * Conservative text redaction shared by every driver sanitizer.
 *
 * Disclaimer: This can really leak. Its never safe
 *
 * Configured secrets are removed exactly. Common authorization/header and URL
 * query shapes are masked as a second line of defence for values the caller did
 * not explicitly seed.
 *
 * Note: add support for diff regex as needed.
 */
export const makeRedactor = (secrets: Iterable<string> = []): Redactor => {
	const configured = [...secrets].filter((secret) => secret.length > 0).sort((a, b) => b.length - a.length);
	return (value) => {
		let redacted = value;
		for (const secret of configured) redacted = redacted.replaceAll(secret, REDACTED);
		return redacted
			.replace(/\b(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, `$1${REDACTED}`)
			.replace(/\b((?:api[-_]?key|token|secret|password)\s*[=:]\s*)[^\s,;&]+/gi, `$1${REDACTED}`)
			.replace(/([?&](?:access_token|api_key|token|secret|password)=)[^&#\s]+/gi, `$1${REDACTED}`)
			.replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED);
	};
};

const errorCode = (cause: unknown): string | undefined => {
	if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
	const code = cause.code;
	return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
};

const errorName = (cause: unknown): string => {
	if (typeof cause !== "object" || cause === null || !("name" in cause) || typeof cause.name !== "string")
		return "Error";
	return cause.name;
};

const errorMessage = (cause: unknown): string => {
	if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string")
		return cause.message;
	return String(cause);
};

export const sanitizeError = (cause: unknown, redact: Redactor = makeRedactor()): SandboxInstance.PersistedError => {
	const code = errorCode(cause);
	return {
		name: redact(errorName(cause)),
		message: redact(errorMessage(cause)),
		...(code === undefined ? {} : { code: redact(code) }),
	};
};

export const providerError = (input: {
	readonly driver: string;
	readonly operation: string;
	readonly cause: unknown;
	readonly redact?: Redactor;
	readonly notFound?: boolean;
}): SandboxProviderError => {
	const error = new SandboxProviderError({
		driver: input.driver,
		operation: input.operation,
		sanitized: sanitizeError(input.cause, input.redact),
	});
	Object.defineProperty(error, rawCause, {
		configurable: false,
		enumerable: false,
		value: input.cause,
		writable: false,
	});
	Object.defineProperty(error, missingResource, {
		configurable: false,
		enumerable: false,
		value: input.notFound === true,
		writable: false,
	});
	return error;
};

export type SandboxMountError =
	| SandboxNotFoundError
	| SandboxDriverNotRegisteredError
	| SandboxUnavailError
	| SandboxRemovedError
	| SandboxProviderError;

export type SandboxCreateError =
	| SandboxDriverNotRegisteredError
	| SandboxDriverRegistrationError
	| SandboxProviderError;

export type SandboxRegisterError =
	| SandboxDriverNotRegisteredError
	| SandboxDriverRegistrationError
	| SandboxProviderError;

export type SandboxReadError = never;

export type SandboxRefreshError =
	| SandboxNotFoundError
	| SandboxDriverNotRegisteredError
	| SandboxUnavailError
	| SandboxUnsupportedError
	| SandboxProviderError;

export type SandboxWakeError = SandboxRefreshError | SandboxRemovedError;

export type SandboxStopError = SandboxWakeError | SandboxBusyError | SandboxTransitionConflictError;

export type SandboxDestroyError = SandboxStopError | SandboxMustBeStoppedError;

export * as SandboxError from "./errors.ts";
