/*
 * @file Harness metrics.
 *
 * Effect owns the instruments, the spans, and the export; this module only names
 * them. Metrics use codework's own names and short labels, so a moving draft
 * convention never renames a dashboard. Effect's OTLP exporter reads a metric's
 * unit from its `unit` attribute.
 */

import { Cause, Effect, Exit, Metric } from "effect";

const durationBuckets = Metric.boundariesFromIterable([
	0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
]);

export const llmDuration = Metric.histogram("codework.llm.duration", {
	description: "Provider request duration",
	attributes: { unit: "s" },
	boundaries: durationBuckets,
});

export const llmTtft = Metric.histogram("codework.llm.ttft", {
	description: "Time to first token: from request start to the first streamed content",
	attributes: { unit: "s" },
	boundaries: Metric.boundariesFromIterable([
		0.001, 0.005, 0.01, 0.02, 0.04, 0.06, 0.08, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
	]),
});

export const llmTokens = Metric.counter("codework.llm.tokens", {
	description: "Tokens used, by type; cache and reasoning tokens are part of input and output",
	attributes: { unit: "{token}" },
	incremental: true,
});

export const llmCost = Metric.counter("codework.llm.cost", {
	description: "Provider request cost from the model catalog's prices",
	attributes: { unit: "USD" },
	incremental: true,
});

export const agentDuration = Metric.histogram("codework.agent.duration", {
	description: "Session run duration, across every turn it drains",
	attributes: { unit: "s" },
	boundaries: Metric.boundariesFromIterable([
		0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 51.2, 102.4, 204.8, 409.6,
	]),
});

export const toolDuration = Metric.histogram("codework.tool.duration", {
	description: "Tool execution duration",
	attributes: { unit: "s" },
	boundaries: durationBuckets,
});

export const sandboxProvisionDuration = Metric.histogram("codework.sandbox.provision.duration", {
	description: "Sandbox driver create and wake duration",
	attributes: { unit: "s" },
	boundaries: durationBuckets,
});

export const sandboxExecDuration = Metric.histogram("codework.sandbox.exec.duration", {
	description: "Sandbox shell command duration",
	attributes: { unit: "s" },
	boundaries: durationBuckets,
});

export const sandboxActive = Metric.gauge("codework.sandbox.active", {
	description: "Managed and remote sandboxes with at least one mount",
	attributes: { unit: "{sandbox}" },
});

export type Attributes = Readonly<Record<string, string>>;

export const record = <Input>(metric: Metric.Metric<Input, unknown>, value: Input, attributes: Attributes) =>
	Metric.update(Metric.withAttributes(metric, attributes), value);

/** Add `delta` to a gauge rather than setting it. */
export const adjust = (metric: Metric.Metric<number, unknown>, delta: number, attributes: Attributes) =>
	Metric.modify(Metric.withAttributes(metric, attributes), delta);

/** The `error` label for a failed exit: the error's own tag, or `interrupted`. */
export const errorType = (cause: Cause.Cause<unknown>): string => {
	if (Cause.hasInterruptsOnly(cause)) return "interrupted";
	const error = Cause.squash(cause);
	return typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
		? error._tag
		: "_OTHER";
};

/** `attributes`, plus `error` when the exit failed. */
export const withError = (attributes: Attributes, exit: Exit.Exit<unknown, unknown>): Attributes =>
	Exit.isSuccess(exit) ? attributes : { ...attributes, error: errorType(exit.cause) };

/** Run `self`, then hand its duration in seconds and its exit to `observe`. */
export const timed = <A, E, R, R2>(
	self: Effect.Effect<A, E, R>,
	observe: (seconds: number, exit: Exit.Exit<A, E>) => Effect.Effect<void, never, R2>,
): Effect.Effect<A, E, R | R2> =>
	Effect.clockWith((clock) => {
		const start = clock.currentTimeMillisUnsafe();
		return self.pipe(Effect.onExit((exit) => observe((clock.currentTimeMillisUnsafe() - start) / 1000, exit)));
	});

export * as Telemetry from "./telemetry.ts";
