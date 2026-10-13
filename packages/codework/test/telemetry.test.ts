/* @effect-diagnostics nodeBuiltinImport:off -- this suite spawns the CLI and serves a fake provider and collector. */
/* @effect-diagnostics globalTimers:off -- the subprocess deadline runs outside any Effect. */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vite-plus/test";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const models = fileURLToPath(new URL("../../../models.gen.json", import.meta.url));
const temps: string[] = [];

afterAll(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

interface OtlpValue {
	readonly stringValue?: string;
	readonly intValue?: number | string;
	readonly doubleValue?: number;
	readonly boolValue?: boolean;
	readonly arrayValue?: { readonly values?: ReadonlyArray<OtlpValue> };
}
interface OtlpAttribute {
	readonly key: string;
	readonly value: OtlpValue;
}
interface OtlpSpan {
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly name: string;
	readonly kind: number;
	readonly startTimeUnixNano: string;
	readonly attributes?: ReadonlyArray<OtlpAttribute>;
	readonly events?: ReadonlyArray<unknown>;
	readonly status?: { readonly code?: number };
}
interface OtlpDataPoint {
	readonly attributes?: ReadonlyArray<OtlpAttribute>;
	readonly asDouble?: number;
	readonly asInt?: number | string;
	readonly count?: number | string;
	readonly sum?: number;
}
interface OtlpMetric {
	readonly name: string;
	readonly unit?: string;
	readonly sum?: { readonly dataPoints: ReadonlyArray<OtlpDataPoint> };
	readonly gauge?: { readonly dataPoints: ReadonlyArray<OtlpDataPoint> };
	readonly histogram?: { readonly dataPoints: ReadonlyArray<OtlpDataPoint> };
}
interface Resource {
	readonly resource?: { readonly attributes?: ReadonlyArray<OtlpAttribute> };
}
interface Export {
	readonly path: string;
	readonly header: string | undefined;
	readonly body: {
		readonly resourceSpans?: ReadonlyArray<
			Resource & { readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<OtlpSpan> }> }
		>;
		readonly resourceMetrics?: ReadonlyArray<
			Resource & { readonly scopeMetrics: ReadonlyArray<{ readonly metrics: ReadonlyArray<OtlpMetric> }> }
		>;
	};
}

const read = (request: IncomingMessage) =>
	new Promise<string>((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});

const sse = (chunks: ReadonlyArray<object>) =>
	`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;

const chunk = (choice: object | undefined, usage?: object) => ({
	id: "chatcmpl-otel",
	object: "chat.completion.chunk",
	created: 1,
	model: "otel-model",
	choices: choice === undefined ? [] : [{ index: 0, ...choice }],
	...(usage === undefined ? {} : { usage }),
});

/**
 * The first successful request answers with one `bash` call; the request that
 * carries its result answers with text. Both report usage, so every GenAI metric records.
 */
const completion = (body: { readonly messages: ReadonlyArray<{ readonly role: string }> }) => {
	const usage = { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 };
	if (body.messages.some((message) => message.role === "tool")) {
		return sse([
			chunk({ delta: { role: "assistant", content: "The note says hello." }, finish_reason: null }),
			chunk({ delta: {}, finish_reason: "stop" }),
			chunk(undefined, usage),
		]);
	}
	return sse([
		chunk({
			delta: {
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "call_otel",
						type: "function",
						function: { name: "bash", arguments: '{"command":"cat note.txt"}' },
					},
				],
			},
			finish_reason: null,
		}),
		chunk({ delta: {}, finish_reason: "tool_calls" }),
		chunk(undefined, usage),
	]);
};

/**
 * One local server is both the OpenAI-compatible provider and the OTLP/HTTP
 * collector. The provider's first answer is a 503, so the turn retries once.
 */
const serve = async () => {
	const exports: Export[] = [];
	let completions = 0;
	const server = createServer(async (request, response) => {
		const body = await read(request);
		const path = request.url ?? "";
		if (path === "/v1/chat/completions") {
			completions += 1;
			if (completions === 1) {
				response.writeHead(503, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "overloaded", type: "server_error" } }));
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(completion(JSON.parse(body)));
			return;
		}
		const header = request.headers["x-otel-test"];
		exports.push({ path, header: typeof header === "string" ? header : undefined, body: JSON.parse(body) });
		response.writeHead(200, { "content-type": "application/json" });
		response.end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}`, exports, close: () => new Promise((resolve) => server.close(resolve)) };
};

/** Spawn asynchronously: the fake provider answers from this process's event loop. */
const runCli = (args: ReadonlyArray<string>, options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }) =>
	new Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }>(
		(resolve, reject) => {
			const child = spawn(process.execPath, ["--conditions=development", cli, ...args], {
				cwd: options.cwd,
				env: options.env,
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (data: Buffer) => {
				stdout += data.toString("utf8");
			});
			child.stderr.on("data", (data: Buffer) => {
				stderr += data.toString("utf8");
			});
			// A hung export or shutdown must not outlive the test and its collector.
			const deadline = setTimeout(() => child.kill("SIGKILL"), 45_000);
			child.on("error", reject);
			child.on("close", (status) => {
				clearTimeout(deadline);
				resolve({ status, stdout, stderr });
			});
		},
	);

const value = (input: OtlpValue): unknown => {
	if (input.stringValue !== undefined) return input.stringValue;
	if (input.intValue !== undefined) return Number(input.intValue);
	if (input.doubleValue !== undefined) return input.doubleValue;
	if (input.boolValue !== undefined) return input.boolValue;
	return (input.arrayValue?.values ?? []).map(value);
};

/** Ids, versions and timings change per run; everything else in the artifact is fixed by the fake provider. */
const volatile = new Set([
	"gen_ai.conversation.id",
	"gen_ai.tool.call.id",
	"gen_ai.response.id",
	"gen_ai.response.time_to_first_chunk",
	"service.instance.id",
	"service.version",
]);

const attributes = (input: ReadonlyArray<OtlpAttribute> | undefined) =>
	Object.fromEntries(
		[...(input ?? [])]
			.sort((left, right) => left.key.localeCompare(right.key))
			.map((attribute) => [attribute.key, volatile.has(attribute.key) ? "<volatile>" : value(attribute.value)]),
	);

const SPAN_KIND = ["unspecified", "internal", "server", "client", "producer", "consumer"];

/**
 * The GenAI spans in start order, each under its nearest GenAI ancestor. Every
 * other harness span is left out: their count follows the database and the
 * sandbox, not the telemetry contract.
 */
const genAiSpans = (exports: ReadonlyArray<Export>) => {
	const spans = exports.flatMap((entry) =>
		(entry.body.resourceSpans ?? []).flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)),
	);
	const byId = new Map(spans.map((span) => [span.spanId, span]));
	const isGenAi = (span: OtlpSpan) => span.attributes?.some((attribute) => attribute.key === "gen_ai.operation.name");
	const ancestor = (span: OtlpSpan): string | undefined => {
		for (let parent = byId.get(span.parentSpanId ?? ""); parent; parent = byId.get(parent.parentSpanId ?? "")) {
			if (isGenAi(parent)) return parent.name;
		}
		return undefined;
	};
	return spans
		.filter(isGenAi)
		.sort((left, right) => (BigInt(left.startTimeUnixNano) < BigInt(right.startTimeUnixNano) ? -1 : 1))
		.map((span) => ({
			name: span.name,
			kind: SPAN_KIND[span.kind] ?? span.kind,
			parent: ancestor(span) ?? null,
			error: span.status?.code === 2,
			attributes: attributes(span.attributes),
		}));
};

// Counts and sums that the fake provider fixes; every other recorded value follows timing.
const exact = new Set(["codework.llm.tokens", "codework.llm.cost"]);
const runtime = (name: string) => name.startsWith("child_fiber");

const recorded = (name: string, point: OtlpDataPoint) => {
	if (runtime(name)) return {};
	const count = point.count === undefined ? {} : { count: Number(point.count) };
	if (!exact.has(name)) return count;
	const total = point.sum ?? point.asDouble ?? (point.asInt === undefined ? undefined : Number(point.asInt));
	return { ...count, value: total === undefined ? null : Number(total.toPrecision(12)) };
};

/**
 * Each metric's unit and type, and each series it exported: its full attribute
 * set with its count, plus its value where the run fixes it. Metrics are
 * cumulative, so the last export of a series is its total.
 */
const metrics = (exports: ReadonlyArray<Export>) => {
	const found = new Map<
		string,
		{ readonly unit: string | undefined; readonly type: string; readonly series: Map<string, object> }
	>();
	for (const entry of exports) {
		for (const resource of entry.body.resourceMetrics ?? []) {
			for (const scope of resource.scopeMetrics) {
				for (const metric of scope.metrics) {
					const type = metric.histogram ? "histogram" : metric.gauge ? "gauge" : "sum";
					const current = found.get(metric.name) ?? { unit: metric.unit, type, series: new Map() };
					for (const point of (metric.histogram ?? metric.gauge ?? metric.sum)?.dataPoints ?? []) {
						const labels = attributes(point.attributes);
						current.series.set(JSON.stringify(labels), { attributes: labels, ...recorded(metric.name, point) });
					}
					found.set(metric.name, current);
				}
			}
		}
	}
	return Object.fromEntries(
		[...found.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, metric]) => [
				name,
				{
					unit: metric.unit,
					type: metric.type,
					series: [...metric.series.entries()]
						.sort(([left], [right]) => left.localeCompare(right))
						.map(([, series]) => series),
				},
			]),
	);
};

/**
 * Every exported span name, with its parent's. By default only the spans marked
 * `Info` leave the process: Effect's own `sql.*` and the harness internals stay out.
 */
const exportedSpans = (exports: ReadonlyArray<Export>) => {
	const spans = exports.flatMap((entry) =>
		(entry.body.resourceSpans ?? []).flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)),
	);
	const byId = new Map(spans.map((span) => [span.spanId, span]));
	return [
		...new Set(spans.map((span) => `${byId.get(span.parentSpanId ?? "")?.name ?? "(root)"} > ${span.name}`)),
	].sort();
};

const resources = (exports: ReadonlyArray<Export>) =>
	exports.flatMap((entry) => [...(entry.body.resourceSpans ?? []), ...(entry.body.resourceMetrics ?? [])]);

/** Run the CLI once against `collector` as its provider and OTLP endpoint, with no other `OTEL_*` set. */
const exportRun = async (collector: Awaited<ReturnType<typeof serve>>, traceLevel?: string) => {
	const home = mkdtempSync(join(tmpdir(), "codework-otel-"));
	temps.push(home);
	const project = join(home, "project");
	const settings = join(home, "settings");
	mkdirSync(project);
	mkdirSync(settings);
	writeFileSync(join(project, "note.txt"), "hello from the note\n");
	writeFileSync(
		join(settings, "settings.jsonc"),
		JSON.stringify({
			retry: { baseDelayMs: 10 },
			model: { provider: "otel", id: "otel-model" },
			models: [
				{
					id: "otel-model",
					name: "otel-model",
					provider: { id: "otel", name: "Otel", source: "config", env: [] },
					baseUrl: `${collector.url}/v1`,
					reasoning: false,
					input: ["text"],
					cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32768,
					maxTokens: 8192,
					protocol: "openai-compatible",
				},
			],
		}),
	);

	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		CODEWORK_MODELS_FILE: models,
		OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
		OTEL_EXPORTER_OTLP_HEADERS: "x-otel-test=present",
		// The collector reads JSON; protobuf is the default otherwise.
		OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
	};
	const configured = new Set([
		"OTEL_EXPORTER_OTLP_ENDPOINT",
		"OTEL_EXPORTER_OTLP_HEADERS",
		"OTEL_EXPORTER_OTLP_PROTOCOL",
	]);
	for (const key of Object.keys(env)) {
		if (key.startsWith("OTEL_") && !configured.has(key)) delete env[key];
	}
	delete env.CODEWORK_TRACE_LEVEL;
	if (traceLevel !== undefined) env.CODEWORK_TRACE_LEVEL = traceLevel;

	const result = await runCli(
		["--home", home, "--database", ":memory:", "--user-config-dir", settings, "run", "What does note.txt say?"],
		{ cwd: project, env },
	);
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout).toContain("The note says hello.");

	// No prompt, command, file content, or model output may leave in any span, attribute, or event.
	const traces = JSON.stringify(collector.exports.filter((entry) => entry.path === "/v1/traces"));
	for (const content of ["What does note.txt say?", "cat note.txt", "hello from the note", "The note says hello."]) {
		expect(traces).not.toContain(content);
	}
};

const artifact = fileURLToPath(new URL("./__artifacts__/telemetry.json", import.meta.url));

describe("OTLP export", () => {
	it("exports GenAI spans and metrics for a run through the standard OTEL_* environment", async () => {
		const collector = await serve();
		try {
			await exportRun(collector);

			expect(collector.exports.length).toBeGreaterThan(0);
			expect(new Set(collector.exports.map((entry) => entry.path))).toEqual(new Set(["/v1/traces", "/v1/metrics"]));
			expect(collector.exports.every((entry) => entry.header === "present")).toBe(true);

			const exported = resources(collector.exports).map((entry) => JSON.stringify(entry.resource));
			expect(new Set(exported).size, "every export carries one resource").toBe(1);

			await expect(
				`${JSON.stringify(
					{
						resource: attributes(resources(collector.exports)[0]?.resource?.attributes),
						exported: exportedSpans(collector.exports),
						spans: genAiSpans(collector.exports),
						metrics: metrics(collector.exports),
					},
					null,
					"\t",
				)}\n`,
			).toMatchFileSnapshot("./__artifacts__/telemetry.json");
		} finally {
			await collector.close();
		}
	}, 60_000);

	it("exports every span, Effect's own sql.* included, with CODEWORK_TRACE_LEVEL=debug", async () => {
		const collector = await serve();
		try {
			await exportRun(collector, "debug");
			const spans = exportedSpans(collector.exports);
			expect(spans.some((pair) => pair.endsWith("> sql.execute"))).toBe(true);
			// Debug adds spans; it never loses the ones exported by default.
			const defaults: ReadonlyArray<string> = JSON.parse(readFileSync(artifact, "utf8")).exported;
			expect(spans).toEqual(expect.arrayContaining([...defaults]));
		} finally {
			await collector.close();
		}
	}, 60_000);
});
