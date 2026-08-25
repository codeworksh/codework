import Type, { type Static } from "typebox";

const metadata = {
	message: Type.String(),
	retryable: Type.Boolean(),
	status: Type.Optional(Type.Number()),
	code: Type.Optional(Type.String()),
	requestId: Type.Optional(Type.String()),
	retryAfterMs: Type.Optional(Type.Number()),
};

const variant = <TTag extends string>(tag: TTag) =>
	Type.Object({
		_tag: Type.Literal(tag),
		...metadata,
	});

export const Authentication = Type.Object({
	_tag: Type.Literal("Authentication"),
	reason: Type.Union([Type.Literal("missing"), Type.Literal("invalid"), Type.Literal("expired")]),
	...metadata,
});
export const Configuration = variant("Configuration");
export const Authorization = variant("Authorization");
export const ModelUnavailable = variant("ModelUnavailable");
export const RateLimit = variant("RateLimit");
export const Quota = variant("Quota");
export const InvalidRequest = variant("InvalidRequest");
export const ContentPolicy = variant("ContentPolicy");
export const Timeout = variant("Timeout");
export const Transport = variant("Transport");
export const Unavailable = variant("Unavailable");
export const InvalidResponse = variant("InvalidResponse");
export const Unknown = variant("Unknown");

/** Provider-independent, JSON-safe failure data carried by terminal assistant messages. */
export const FailureSchema = Type.Union([
	Authentication,
	Configuration,
	Authorization,
	ModelUnavailable,
	RateLimit,
	Quota,
	InvalidRequest,
	ContentPolicy,
	Timeout,
	Transport,
	Unavailable,
	InvalidResponse,
	Unknown,
]);
export type Failure = Static<typeof FailureSchema>;

const tags = new Set<Failure["_tag"]>([
	"Authentication",
	"Configuration",
	"Authorization",
	"ModelUnavailable",
	"RateLimit",
	"Quota",
	"InvalidRequest",
	"ContentPolicy",
	"Timeout",
	"Transport",
	"Unavailable",
	"InvalidResponse",
	"Unknown",
]);

const record = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

/** Lightweight guard for failure data crossing package or persistence boundaries. */
export function isFailure(value: unknown): value is Failure {
	const candidate = record(value);
	return (
		tags.has(candidate?._tag as Failure["_tag"]) &&
		typeof candidate?.message === "string" &&
		typeof candidate.retryable === "boolean" &&
		(candidate.status === undefined || (typeof candidate.status === "number" && Number.isFinite(candidate.status))) &&
		(candidate.code === undefined || typeof candidate.code === "string") &&
		(candidate.requestId === undefined || typeof candidate.requestId === "string") &&
		(candidate.retryAfterMs === undefined ||
			(typeof candidate.retryAfterMs === "number" &&
				Number.isFinite(candidate.retryAfterMs) &&
				candidate.retryAfterMs >= 0)) &&
		(candidate._tag !== "Authentication" ||
			candidate.reason === "missing" ||
			candidate.reason === "invalid" ||
			candidate.reason === "expired")
	);
}
