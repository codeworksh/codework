/*
 * @file Agent-level retry policy for a failed provider request.
 *
 * Pure: the loop owns the attempts, the sleep and the events; this decides whether a failure is
 * worth another attempt and how long to wait first.
 */

import { Duration, Schema } from "effect";
import type { RetryPolicy } from "../settings/schema.ts";
import { Runner } from "./run.ts";

/**
 * Milliseconds to wait before retry `attempt` (1-based), or `undefined` to give up.
 *
 * Only a provider failure the provider itself calls transient is retried. A quota error is
 * excluded even though it often arrives as a retryable 429: waiting does not refill a quota.
 * Context overflow is a non-retryable 400 and is left to compaction.
 *
 * A server-sent `retry-after` raises the delay, never lowers it. One longer than `maxDelayMs`
 * gives up rather than retrying early into the same rejection.
 */
export const delay = (policy: RetryPolicy, attempt: number, error: unknown): number | undefined => {
	if (attempt > policy.maxRetries) return undefined;
	if (!Schema.is(Runner.ProviderError)(error) || !error.isRetryable) return undefined;
	if (error.reason._tag === "Runner.ProviderQuotaError") return undefined;
	const backoff = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
	const requested = error.reason.retryAfter === undefined ? 0 : Duration.toMillis(error.reason.retryAfter);
	return requested > policy.maxDelayMs ? undefined : Math.max(backoff, Math.ceil(requested));
};

export * as Retry from "./retry.ts";
