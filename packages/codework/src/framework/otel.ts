import { Config, ConfigProvider, Effect, Layer, Metric, Option, Schema } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";
import { OtlpExporter, OtlpMetrics, OtlpSerialization, OtlpTracer } from "effect/observability";
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
 * Serialize each signal by its `OTEL_EXPORTER_OTLP_*PROTOCOL`, defaulting to the
 * spec's `http/protobuf`. Effect has no gRPC exporter, so `grpc` exports nothing
 * rather than sending HTTP to a gRPC port.
 */
const serialized = (
	signal: "TRACES" | "METRICS",
	self: Layer.Layer<OtlpExporter.Flusher, never, HttpClient.HttpClient | OtlpSerialization.OtlpSerialization>,
): Layer.Layer<OtlpExporter.Flusher, never, HttpClient.HttpClient> =>
	Layer.unwrap(
		Effect.gen(function* () {
			const protocol = yield* Config.String(`OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`).pipe(
				Config.orElse(() => Config.String("OTEL_EXPORTER_OTLP_PROTOCOL")),
				Config.withDefault("http/protobuf"),
			);
			switch (protocol.trim().toLowerCase()) {
				case "http/json":
					return Layer.provide(self, OtlpSerialization.layerJson);
				case "http/protobuf":
					return Layer.provide(self, OtlpSerialization.layerProtobuf);
				default:
					return OtlpExporter.layerFlusher;
			}
		}),
	).pipe(Layer.orDie);

/** The release channel a version was published to, from its prerelease tag. */
const channel = (version: string) =>
	version.includes("-canary.") ? "canary" : version.includes("-dev.") ? "dev" : "latest";

const instanceId = uuidv7();

export const layer = (options: { readonly version: string; readonly command: string }) => {
	const resource = {
		serviceName: "codework",
		serviceVersion: options.version,
		attributes: {
			"service.instance.id": instanceId,
			"deployment.environment.name": channel(options.version),
			"codework.command": options.command,
		},
	};
	return Layer.mergeAll(
		serialized("TRACES", OtlpTracer.layerFromConfig({ resource })),
		serialized("METRICS", OtlpMetrics.layerFromConfig({ resource })),
		fiberMetrics,
	).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(exporterDefaults),
		Layer.catchCause(() => Layer.empty),
	);
};

export * as Otel from "./otel.ts";
