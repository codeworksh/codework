/* @effect-diagnostics globalFetch:off nodeBuiltinImport:off -- a real HTTP proxy outside any Effect. */
import { llm } from "@codeworksh/aikit";
import { Effect } from "effect";
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { Event } from "../src/event/event.ts";
import { withSettings } from "./fixtures/settings.ts";
import { available, LIVE } from "./utils/live.ts";

/** Resolves once the chunk has left Node's buffers, so a following cut cannot discard it. */
const flushed = (res: ServerResponse, chunk: Uint8Array) =>
	new Promise<void>((resolve, reject) => res.write(chunk, (error) => (error ? reject(error) : resolve())));

/**
 * A proxy in front of the real provider that fails on a script: request 1 is a real 503 with
 * `retry-after-ms`, request 2 is forwarded upstream and cut once a streamed delta has reached the
 * client, and every later request is forwarded whole. The harness, AI SDK and aikit see genuine
 * HTTP failures. Each request's arrival time and body are recorded.
 */
const proxy = async (upstream: string) => {
	const requests: Array<{ readonly at: number; body: Buffer }> = [];
	const forward = async (req: IncomingMessage, res: ServerResponse, body: Buffer, cut: boolean) => {
		const headers = new Headers();
		for (const [key, value] of Object.entries(req.headers)) {
			if (value === undefined || ["host", "content-length", "connection", "accept-encoding"].includes(key)) continue;
			headers.set(key, Array.isArray(value) ? value.join(", ") : value);
		}
		const response = await fetch(`${upstream}${req.url ?? ""}`, {
			method: req.method ?? "POST",
			headers,
			...(body.length === 0 ? {} : { body }),
		});
		const passed: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key))
				passed[key] = value;
		});
		res.writeHead(response.status, passed);
		if (response.body === null) return res.end();
		if (!cut) {
			for await (const chunk of response.body) await flushed(res, chunk);
			return res.end();
		}
		/*
		 * A dropped connection mid-stream. Forward exactly through the first SSE event naming a
		 * `…delta…` (every provider's content events do), then cut: one network chunk can carry the
		 * whole short response, so cutting at a chunk boundary could deliver it complete. The pause
		 * lets the client parse the flushed event before the socket goes.
		 */
		const decoder = new TextDecoder();
		let pending = "";
		for await (const chunk of response.body) {
			pending += decoder.decode(chunk, { stream: true });
			const events = pending.split(/\r?\n\r?\n/);
			pending = events.pop() ?? "";
			for (const event of events) {
				await flushed(res, new TextEncoder().encode(`${event}\n\n`));
				if (!event.includes("delta")) continue;
				await new Promise((resolve) => setTimeout(resolve, 100));
				return res.socket?.destroy();
			}
		}
		res.end();
	};
	const server = createServer((req, res) => {
		// Raw bytes: a client may compress its request body, which a text round-trip would corrupt.
		const request = { at: performance.now(), body: Buffer.alloc(0) };
		requests.push(request);
		const index = requests.length;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			request.body = Buffer.concat(chunks);
			if (index === 1) {
				res.writeHead(503, { "content-type": "application/json", "retry-after-ms": "300" });
				return res.end(JSON.stringify({ error: { message: "upstream overloaded", type: "overloaded_error" } }));
			}
			forward(req, res, request.body, index === 2).catch(() => res.socket?.destroy());
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		requests: () => requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
};

// One model per provider: the retry path does not differ between models of one provider.
const cases = LIVE.filter((live, index) => LIVE.findIndex((other) => other.provider === live.provider) === index);

describe.each(cases)("loop retry against live $name", (live) => {
	it.skipIf(!available(live))(
		"retries a real 503 and a real mid-stream drop, then commits the real answer",
		{ timeout: 180_000 },
		() =>
			withSettings(async ({ root, custom }) => {
				const catalog = await llm(live.provider, live.id);
				if (catalog === undefined) throw new Error(`${live.provider}/${live.id} is not in the catalog`);
				const upstream = await proxy(catalog.baseUrl.replace(/\/$/, ""));
				try {
					await writeFile(
						join(custom, "settings.jsonc"),
						JSON.stringify({
							retry: { maxRetries: 3, baseDelayMs: 200, maxDelayMs: 5_000 },
							model: {
								provider: live.provider,
								id: live.id,
								thinkingLevel: "low",
								options: { baseURL: upstream.url },
							},
						}),
					);
					const { journal, fragments, path } = await Effect.runPromise(
						Effect.gen(function* () {
							const events = yield* Event.Service;
							const journal: Array<Record<string, unknown>> = [];
							// Streamed fragments per draft: how a client knows a response had started.
							const fragments = new Map<string, number>();
							yield* events.listen((event) =>
								Effect.sync(() => {
									if (
										event.type.startsWith("session.llm.text.") ||
										event.type.startsWith("session.llm.thinking.")
									) {
										const id = (event.data as { readonly messageId: string }).messageId;
										fragments.set(id, (fragments.get(id) ?? 0) + 1);
									}
									const lifecycle = [
										"session.turn.",
										"session.llm.started",
										"session.llm.ended",
										"session.llm.failed",
										"session.retry.",
									];
									if (!lifecycle.some((prefix) => event.type.startsWith(prefix))) return;
									const data = event.data as Record<string, unknown>;
									journal.push({
										type: event.type,
										...Object.fromEntries(
											["attempt", "maxRetries", "delayMs", "success", "reason"]
												.filter((key) => data[key] !== undefined)
												.map((key) => [key, data[key]]),
										),
									});
								}),
							);
							const handle = yield* Session.create({ directory: root });
							yield* handle.run("Reply with the single word: retried");
							return { journal, fragments, path: yield* handle.path() };
						}).pipe(
							Effect.provide(
								Harness.layer({
									home: join(root, "home"),
									hostCwd: root,
									database: ":memory:",
									userConfigDir: custom,
								}),
							),
							Effect.scoped,
							Effect.timeout("150 seconds"),
						),
					);

					const requests = upstream.requests();
					expect(requests).toHaveLength(3);
					// The waits were actually taken, not only reported: the server's 300ms, then 2 × 200ms.
					expect(requests[1]!.at - requests[0]!.at).toBeGreaterThanOrEqual(295);
					expect(requests[2]!.at - requests[1]!.at).toBeGreaterThanOrEqual(395);
					// Every attempt sends the original context: no failed attempt or partial output leaks in.
					expect(requests[1]!.body.equals(requests[0]!.body)).toBe(true);
					expect(requests[2]!.body.equals(requests[0]!.body)).toBe(true);

					const assistants = path.filter((hydrated) => hydrated.entry.type === "assistant");
					expect(assistants.map((hydrated) => hydrated.entry.state)).toEqual(["aborted", "aborted", "committed"]);
					expect(assistants[0]!.parts).toEqual([]);
					expect(assistants[1]!.parts).toEqual([]);
					// Attempt 1 failed before any byte of a response; attempt 2 failed mid-stream.
					expect(fragments.get(assistants[0]!.entry.id) ?? 0).toBe(0);
					expect(fragments.get(assistants[1]!.entry.id) ?? 0).toBeGreaterThan(0);
					const answer = assistants[2]!.parts
						.filter((part) => part.type === "text")
						.map((part) => (JSON.parse(part.data) as { readonly text?: string }).text ?? "")
						.join("");
					expect(answer.trim().length).toBeGreaterThan(0);

					// Delays are deterministic: the server's 300ms beats the 200ms base, then 2 × 200ms.
					await expect(journal).toMatchFileSnapshot(`./__artifacts__/runner.retry.live.${live.provider}.json`);
				} finally {
					await upstream.close();
				}
			}),
	);
});
