/*
 * @file Harness metrics and the GenAI span vocabulary.
 *
 * Effect owns the instruments, the spans, and the export; this module only names
 * them. Names follow the OpenTelemetry GenAI conventions where one exists, and
 * Effect's OTLP exporter reads a metric's unit from its `unit` attribute.
 */

import { Cause, Effect, type Exit, Metric } from "effect";

// Bucket boundaries are the GenAI conventions' advice for each instrument.
const durationBuckets = Metric.boundariesFromIterable([
	0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
]);

export const tokenUsage = Metric.histogram("gen_ai.client.token.usage", {
	description: "Tokens used per provider request",
	attributes: { unit: "{token}" },
	boundaries: Metric.boundariesFromIterable([
		1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
	]),
});

export const operationDuration = Metric.histogram("gen_ai.client.operation.duration", {
	description: "Provider request duration",
	attributes: { unit: "s" },
	boundaries: durationBuckets,
});

// The `gen_ai.server.*` timings are a model server's own measure; a client also times the transport.
export const timeToFirstToken = Metric.histogram("codework.llm.time_to_first_token", {
	description: "Time from request start to the first streamed content",
	attributes: { unit: "s" },
	boundaries: Metric.boundariesFromIterable([
		0.001, 0.005, 0.01, 0.02, 0.04, 0.06, 0.08, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
	]),
});

export const timePerOutputToken = Metric.histogram("codework.llm.time_per_output_token", {
	description: "Generation time after the first token, per later output token",
	attributes: { unit: "s" },
	boundaries: Metric.boundariesFromIterable([0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1, 2.5]),
});

export const toolDuration = Metric.histogram("gen_ai.execute_tool.duration", {
	description: "Tool execution duration",
	attributes: { unit: "s" },
	boundaries: durationBuckets,
});

export const agentDuration = Metric.histogram("gen_ai.invoke_agent.duration", {
	description: "Session run duration, across every turn it drains",
	attributes: { unit: "s" },
	boundaries: durationBuckets,
});

export const cost = Metric.counter("codework.llm.cost", {
	description: "Provider request cost from the model catalog's prices",
	attributes: { unit: "USD" },
	incremental: true,
});

export const retries = Metric.counter("codework.turn.retries", {
	description: "Provider requests retried within a turn",
	attributes: { unit: "{retry}" },
	incremental: true,
});

export const provisionDuration = Metric.histogram("codework.sandbox.provision.duration", {
	description: "Sandbox driver create and wake duration",
	attributes: { unit: "s" },
	boundaries: durationBuckets,
});

export const truncated = Metric.counter("codework.tool.output.truncated", {
	description: "Tool results whose output was truncated before the model saw it",
	attributes: { unit: "{call}" },
	incremental: true,
});

export type Attributes = Readonly<Record<string, string>>;

export const record = <Input>(metric: Metric.Metric<Input, unknown>, value: Input, attributes: Attributes) =>
	Metric.update(Metric.withAttributes(metric, attributes), value);

/** `error.type` for a failed exit: the error's own tag, or `interrupted`. */
export const errorType = (cause: Cause.Cause<unknown>): string => {
	if (Cause.hasInterruptsOnly(cause)) return "interrupted";
	const error = Cause.squash(cause);
	return typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
		? error._tag
		: "_OTHER";
};

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
