import { Config, ConfigProvider, Effect, Layer, Metric, Option, References, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpMetrics, OtlpSerialization, OtlpTracer } from "effect/observability";
import { uuidv7 } from "uuidv7";

/**
 * OTLP export of the harness's spans and metrics, configured by the standard
 * `OTEL_*` environment variables alone. Without an endpoint every layer is
 * empty; a configuration that fails to build runs the command without export.
 */

// The OTel spec defaults `OTEL_{TRACES,METRICS}_EXPORTER` to `otlp`; Effect reads an
// unset list as none, so an endpoint alone would export nothing.
const exporterDefaults = ConfigProvider.layerAdd(
	ConfigProvider.fromUnknown({ OTEL_TRACES_EXPORTER: ["otlp"], OTEL_METRICS_EXPORTER: ["otlp"] }),
);

// Effect's fiber metrics hook every fiber start and end, so they follow metrics export.
const metricsEnabled = Config.all({
	disabled: Config.Boolean("OTEL_SDK_DISABLED").pipe(Config.withDefault(false)),
	endpoint: Config.String("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT").pipe(
		Config.orElse(() => Config.String("OTEL_EXPORTER_OTLP_ENDPOINT")),
		Config.option,
	),
	exporters: Config.Array(Schema.String, "OTEL_METRICS_EXPORTER"),
}).pipe(
	Config.map(
		({ disabled, endpoint, exporters }) =>
			!disabled && Option.isSome(endpoint) && exporters.some((exporter) => exporter.trim().toLowerCase() === "otlp"),
	),
);

const fiberMetrics = Layer.unwrap(
	Effect.gen(function* () {
		return (yield* metricsEnabled) ? Metric.enableRuntimeMetricsLayer : Layer.empty;
	}),
);

/**
 * Export only the spans marked `level: "Info"`: the command, the agent loop, model
 * and tool calls, and sandbox provisioning. Every other span, Effect's own `sql.*`
 * among them, defaults to `Debug`; `CODEWORK_TRACE_LEVEL=debug` exports those too.
 * Effect drops a span's children with it, so every span on the path from a command
 * to a model call must be `Info`.
 */
const levels = { all: "All", trace: "Trace", debug: "Debug", info: "Info", warn: "Warn", error: "Error" } as const;

const traceLevels = Layer.unwrap(
	Effect.gen(function* () {
		const name = yield* Config.String("CODEWORK_TRACE_LEVEL").pipe(Config.withDefault("info"));
		const minimum = levels[name.trim().toLowerCase() as keyof typeof levels] ?? "Info";
		return Layer.mergeAll(
			Layer.succeed(References.CurrentTraceLevel, "Debug"),
			Layer.succeed(References.MinimumTraceLevel, minimum),
		);
	}),
);

interface OtlpResource {
	readonly serviceName: string;
	readonly serviceVersion: string;
	readonly attributes: Record<string, string>;
}

/**
 * Serialize by `OTEL_EXPORTER_OTLP_PROTOCOL`, defaulting to the spec's
 * `http/protobuf`. Effect has no gRPC exporter, so `grpc` exports nothing
 * rather than sending HTTP to a gRPC port.
 */
const exporters = (resource: OtlpResource) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const protocol = yield* Config.String("OTEL_EXPORTER_OTLP_PROTOCOL").pipe(Config.withDefault("http/protobuf"));
			const format = {
				"http/json": OtlpSerialization.layerJson,
				"http/protobuf": OtlpSerialization.layerProtobuf,
			}[protocol.trim().toLowerCase()];
			if (format === undefined) return Layer.empty;
			return Layer.mergeAll(
				OtlpTracer.layerFromConfig({ resource }),
				OtlpMetrics.layerFromConfig({ resource }),
			).pipe(Layer.provide(format));
		}),
	);

/** The release channel a version was published to, from its prerelease tag. */
const channel = (version: string) =>
	version.includes("-canary.") ? "canary" : version.includes("-dev.") ? "dev" : "latest";

const instanceId = uuidv7();

export const layer = (options: { readonly version: string; readonly command: string }) => {
	const resource: OtlpResource = {
		serviceName: "codework",
		serviceVersion: options.version,
		attributes: {
			"service.instance.id": instanceId,
			"deployment.environment.name": channel(options.version),
			"codework.command": options.command,
		},
	};
	return Layer.mergeAll(exporters(resource), fiberMetrics, traceLevels).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(exporterDefaults),
		Layer.catchCause(() => Layer.empty),
	);
};

export * as Otel from "./otel.ts";
