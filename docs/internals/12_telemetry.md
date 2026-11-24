# Telemetry

CodeWork records two different kinds of numbers, and they do not share code. OpenTelemetry export is for operators: opt-in, configured by the environment, sent to a collector the user runs. The usage rollup is product data: always on, persisted in the harness database, and shown on the desktop app's Metrics page. This page is mostly about the first.

## Who Owns What

- **Instruments live in the harness.** [telemetry.ts](../../packages/harness/src/telemetry/telemetry.ts) declares the metrics and the small helpers that record them. Spans are plain `Effect.fn` and `Effect.withSpan` calls at the boundaries that matter. The harness never exports anything on its own; whoever embeds it decides whether to.
- **The exporter lives in the CLI.** [otel.ts](../../packages/codework/src/framework/otel.ts) builds Effect's OTLP tracer and metrics layers, and [runtime.ts](../../packages/codework/src/framework/runtime.ts) provides that layer around every command handler. Every `codework` command, `serve` and `acp` included, exports the same way.
- **aikit is untouched.** Provider calls are measured in [llm.ts](../../packages/harness/src/runner/llm.ts), the harness's Effect boundary around aikit's stream. aikit stays plain TypeScript with no telemetry dependency. Keep it that way; measure at the harness boundary instead.

We use Effect's own `Otlp*`, `Metric` and span APIs rather than the OpenTelemetry SDK, so there is no second runtime or SDK dependency to keep in step with Effect.

## Configuration Is the Environment

There is no settings key. The standard `OTEL_*` variables configure export, and nothing else does. Without an endpoint nothing is exported. Decisions in [otel.ts](../../packages/codework/src/framework/otel.ts) a maintainer could get wrong:

- **An endpoint alone is enough.** The OpenTelemetry spec defaults the traces and metrics exporters to `otlp`, but Effect reads an unset exporter list as none. We add `otlp` as the default so the spec's behavior holds.
- **A bad configuration never fails a command.** The whole layer is wrapped in `Layer.catchCause`, so a configuration that cannot build runs the command without export.
- **`grpc` exports nothing.** Effect has no gRPC exporter. We drop export rather than send HTTP to a gRPC port. Only `http/protobuf` (the default) and `http/json` work.
- **Fiber runtime metrics follow metrics export.** Effect's fiber metrics hook every fiber start and end, so they are enabled only when metrics would actually be exported.
- **The resource says where the data came from.** The service name is `codework`. The deployment environment is the release channel, derived from the version string (see [releasing](./14_releasing.md)). The command path and a per-process instance id are attributes too.

## Span Levels Decide What Is Exported

Only spans marked `level: "Info"` are exported by default. Everything else, Effect's own `sql.*` spans among them, defaults to `Debug`. `CODEWORK_TRACE_LEVEL` lowers the minimum, for example to `debug` to see database queries.

The trap: Effect drops a span's children along with it. A `Debug` span anywhere on the path from a command to a model or tool call hides every `Info` span below it. So:

- Every span from the command handler down to the loop, the model request, the tool call and sandbox provisioning carries `level: "Info"`. Adding a new span on that path without a level silently cuts the trace.
- The RPC server's request span has no level, so it is `Debug`. RPC handlers that are worth tracing, sandbox provisioning today, start a root `Info` span of their own (`exported` in [handlers.ts](../../packages/codework/src/server/handlers.ts)).

## What We Record

Metric names are our own (`codework.*`), not the OpenTelemetry GenAI metric names. Those conventions are still a draft and keep renaming. Span attributes do use the GenAI `gen_ai.*` attributes. Effect's OTLP exporter reads a metric's unit from a `unit` attribute, which is why each metric declares one.

The instruments cover four boundaries: model requests, agent runs, tool calls and sandboxes. Rules that are not obvious from the list:

- **Prompts, file contents and model output are never exported.** Spans carry ids, names, counts and reasons only.
- **Input tokens include cached tokens.** aikit's `input` excludes cache reads and writes. Telemetry adds them back so input means what the GenAI conventions mean.
- **An interrupted model request still records what it spent.** The harness drains aikit's terminal event after an interrupt, and its usage is recorded.
- **A failed terminal is an error on the span.** aikit reports provider failures as a terminal event, not a thrown error. The harness turns it into a span failure, then recovers it just outside the span, so the trace shows an error status.
- **Errors are a low-cardinality attribute**, `error` on metrics and `error.type` on the model request span. It is the provider failure's reason tag, `aborted`, a tagged error's `_tag`, `interrupted`, or `_OTHER` ([telemetry.ts](../../packages/harness/src/telemetry/telemetry.ts)). Never put a message in it.
- **Tool names are bounded.** A call to a tool the model was not offered is recorded as `_OTHER`, so a hallucinated name cannot create a new series.
- **Agent duration spans the whole run**, across every turn it drains, not one model request.
- **Timing uses Effect's `Clock`**, through `Telemetry.timed`, never `Date.now()`. Tests on a test clock stay deterministic.

## The Usage Rollup Is Not Telemetry

The desktop Metrics page does not read OpenTelemetry. The harness rolls each finalised assistant entry, committed user prompt and tool call into hourly rows per thread in its own database ([usage.ts](../../packages/harness/src/usage/usage.ts)). The rows outlive their session, so they copy its session and project ids instead of using foreign keys. An entry counts once, at the transition that finalises it, and only a committed request is timed. The app server mirrors these rows over the `usage.sync` RPC ([sync.ts](../../apps/server/src/sync.ts)), and [metrics.ts](../../apps/server/src/metrics.ts) buckets them into the viewer's time zone. SQLite has no zones, so that bucketing happens in code.

Keep the two apart. A new number the user should see in the app belongs in the rollup. A number an operator watches belongs in a metric.

## Testing

[telemetry.test.ts](../../packages/codework/test/telemetry.test.ts) spawns the real CLI against one local server that is both an OpenAI-compatible provider and an OTLP collector. It snapshots the exported spans and metrics to `__artifacts__/telemetry.json`. A change to span names, levels or attributes shows up there as drift.
