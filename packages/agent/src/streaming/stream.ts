import { Global } from "../config/global";
import { lazy } from "@codeworksh/utils";
import path from "node:path";
import { StreamStore, FileBackedStreamStore } from "@durable-streams/server";
import { DurableStream, IdempotentProducer } from "@durable-streams/client";

export namespace Stream {
	const STREAM_NEXT_OFFSET = "Stream-Next-Offset";
	const STREAM_CURSOR = "Stream-Cursor";
	const STREAM_UP_TO_DATE = "Stream-Up-To-Date";
	const STREAM_CLOSED = "Stream-Closed";
	const STREAM_SEQ = "Stream-Seq";
	const STREAM_TTL = "Stream-TTL";
	const STREAM_EXPIRES_AT = "Stream-Expires-At";
	const STREAM_FORKED_FROM = "Stream-Forked-From";
	const STREAM_FORK_OFFSET = "Stream-Fork-Offset";
	const STREAM_SSE_DATA_ENCODING = "Stream-SSE-Data-Encoding";
	const PRODUCER_ID = "Producer-Id";
	const PRODUCER_EPOCH = "Producer-Epoch";
	const PRODUCER_SEQ = "Producer-Seq";
	const PRODUCER_EXPECTED_SEQ = "Producer-Expected-Seq";
	const PRODUCER_RECEIVED_SEQ = "Producer-Received-Seq";

	const internalOrigin = "http://codework.internal";

	type ProducerResult =
		| { status: "accepted" }
		| { status: "duplicate"; lastSeq: number }
		| { status: "stale_epoch"; currentEpoch: number }
		| { status: "invalid_epoch_seq" }
		| { status: "sequence_gap"; expectedSeq: number; receivedSeq: number }
		| { status: "stream_closed" };

	type StoreAppendResult =
		| { offset: string }
		| {
				message: { offset: string } | null;
				producerResult?: ProducerResult;
				streamClosed?: boolean;
		  }
		| null;

	function readIntegerHeader(headers: Headers, name: string): number | undefined {
		const value = headers.get(name);
		if (value === null) {
			return undefined;
		}

		if (!/^\d+$/.test(value)) {
			throw new Error(`Invalid ${name}`);
		}

		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed) || parsed < 0) {
			throw new Error(`Invalid ${name}`);
		}

		return parsed;
	}

	function readTtlHeader(headers: Headers): number | undefined {
		const value = headers.get(STREAM_TTL);
		if (value === null) return undefined;
		if (!/^(0|[1-9]\d*)$/.test(value)) {
			throw new Error(`Invalid ${STREAM_TTL}`);
		}
		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed) || parsed < 0) {
			throw new Error(`Invalid ${STREAM_TTL}`);
		}
		return parsed;
	}

	export type Store = FileBackedStreamStore | StreamStore;
	export type StoreInput = Store | (() => Store | Promise<Store>);
	export type CreateInput = {
		store?: StoreInput;
		producerId: string;
		onError?: (error: Error) => void;
	};
	export type Handle = {
		url: string;
		fetch: typeof globalThis.fetch;
		client: DurableStream;
		producer: IdempotentProducer;
		append(payload: unknown): Promise<void>;
		flush(): Promise<void>;
		detach(): Promise<void>;
	};
	export type ReaderHandle = {
		url: string;
		fetch: typeof globalThis.fetch;
		client: DurableStream;
	};
	export type ReaderInput = {
		store?: StoreInput;
	};

	const fetchCache = new WeakMap<Store, typeof globalThis.fetch>();

	const _fileStore = lazy(
		() =>
			new FileBackedStreamStore({
				dataDir: path.join(Global.Path.data, "stream"),
			}),
	);
	const _memoryStore = lazy(() => new StreamStore());

	export function fileStore(): FileBackedStreamStore {
		return _fileStore();
	}

	export function memoryStore(): StreamStore {
		return _memoryStore();
	}

	function resolveStore(input: StoreInput): Promise<Store> {
		if (typeof input === "function") return Promise.resolve(input());
		return Promise.resolve(input);
	}

	function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	}

	function isAppendResult(result: StoreAppendResult): result is Extract<StoreAppendResult, { message: unknown }> {
		return result !== null && typeof result === "object" && "message" in result;
	}

	// function delay(ms: number): Promise<void> {
	//     return new Promise((resolve) => setTimeout(resolve, ms))
	// }

	function toProducerResponse(
		result: ProducerResult,
		producerEpoch: number | undefined,
		_: number | undefined,
	): Response | null {
		switch (result.status) {
			case "accepted":
				return null;
			case "duplicate":
				return new Response(null, {
					status: 204,
					headers: cleanHeaders({
						[PRODUCER_EPOCH]: String(producerEpoch),
						[PRODUCER_SEQ]: String(result.lastSeq),
					}),
				});
			case "stale_epoch":
				return new Response("Stale producer epoch", {
					status: 403,
					headers: {
						[PRODUCER_EPOCH]: String(result.currentEpoch),
					},
				});
			case "sequence_gap":
				return new Response("Producer sequence gap", {
					status: 409,
					headers: {
						[PRODUCER_EXPECTED_SEQ]: String(result.expectedSeq),
						[PRODUCER_RECEIVED_SEQ]: String(result.receivedSeq),
					},
				});
			case "invalid_epoch_seq":
				return new Response("New epoch must start with sequence 0", {
					status: 400,
				});
			case "stream_closed":
				return new Response("Stream is closed", { status: 409 });
		}
	}

	function cleanHeaders(headers: Record<string, string | undefined>): Record<string, string> {
		return Object.fromEntries(
			Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined),
		);
	}

	function isJsonContentType(contentType: string | undefined) {
		return contentType?.toLowerCase().split(";")[0]?.trim() === "application/json";
	}

	function isSseTextCompatible(contentType: string | undefined) {
		const normalized = contentType?.toLowerCase().split(";")[0]?.trim() ?? "";
		return normalized.startsWith("text/") || normalized === "application/json";
	}

	function streamClosedHeader(stream: { closed?: boolean } | undefined) {
		return stream?.closed ? "true" : undefined;
	}

	function streamAtTail(stream: { currentOffset: string } | undefined, offset: string) {
		return stream?.currentOffset === offset;
	}

	function responseCursor(cursor: string | null | undefined) {
		return cursor ? `${cursor}:next` : String(Date.now());
	}

	function encodeSseData(payload: string) {
		const lines = payload.split(/\r\n|\r|\n/);
		return lines.map((line) => `data:${line}`).join("\n") + "\n\n";
	}

	function encodeSseEvent(type: "data" | "control", payload: string) {
		return `event: ${type}\n${encodeSseData(payload)}`;
	}

	async function handleCreate(store: Store, path: string, request: Request): Promise<Response> {
		const contentType = request.headers.get("content-type") ?? "application/octet-stream";
		const ttlSeconds = readTtlHeader(request.headers);
		const expiresAt = request.headers.get(STREAM_EXPIRES_AT) ?? undefined;
		const closed = request.headers.get(STREAM_CLOSED) === "true";
		const forkedFrom = request.headers.get(STREAM_FORKED_FROM) ?? undefined;
		const forkOffset = request.headers.get(STREAM_FORK_OFFSET) ?? undefined;
		const body = new Uint8Array(await request.arrayBuffer());
		const isNew = !store.has(path);

		if (ttlSeconds !== undefined && expiresAt !== undefined) {
			return new Response(`Cannot specify both ${STREAM_TTL} and ${STREAM_EXPIRES_AT}`, { status: 400 });
		}
		if (expiresAt !== undefined && Number.isNaN(new Date(expiresAt).getTime())) {
			return new Response(`Invalid ${STREAM_EXPIRES_AT}`, { status: 400 });
		}
		if (forkOffset !== undefined && !/^\d+_\d+$/.test(forkOffset)) {
			return new Response(`Invalid ${STREAM_FORK_OFFSET}`, { status: 400 });
		}

		await store.create(path, {
			contentType,
			ttlSeconds,
			expiresAt,
			initialData: body.length > 0 ? body : undefined,
			closed,
			forkedFrom,
			forkOffset,
		});

		const current = store.get(path);
		if (!current) {
			return new Response("Stream not found after create", { status: 500 });
		}

		return new Response(null, {
			status: isNew ? 201 : 200,
			headers: cleanHeaders({
				"content-type": current.contentType ?? contentType,
				[STREAM_NEXT_OFFSET]: current.currentOffset,
				[STREAM_CLOSED]: streamClosedHeader(current),
				[STREAM_TTL]: current.ttlSeconds === undefined ? undefined : String(current.ttlSeconds),
				[STREAM_EXPIRES_AT]: current.expiresAt,
			}),
		});
	}

	function handleHead(store: Store, path: string): Response {
		const current = store.get(path);
		if (!current) {
			return new Response(null, { status: 404 });
		}

		return new Response(null, {
			status: 200,
			headers: cleanHeaders({
				"content-type": current.contentType,
				[STREAM_NEXT_OFFSET]: current.currentOffset,
				[STREAM_CLOSED]: streamClosedHeader(current),
				[STREAM_TTL]: current.ttlSeconds === undefined ? undefined : String(current.ttlSeconds),
				[STREAM_EXPIRES_AT]: current.expiresAt,
				etag: `"${Buffer.from(path).toString("base64")}:-1:${current.currentOffset}${current.closed ? ":c" : ""}"`,
				"cache-control": "no-store",
			}),
		});
	}

	async function handleRead(store: Store, url: URL, request: Request): Promise<Response> {
		const current = store.get(url.pathname);
		if (!current) {
			return new Response("Stream not found", { status: 404 });
		}

		const live = url.searchParams.get("live");
		const requestedOffset = url.searchParams.get("offset") ?? undefined;
		if (requestedOffset === "") {
			return new Response("Empty offset parameter", { status: 400 });
		}
		if (url.searchParams.getAll("offset").length > 1) {
			return new Response("Multiple offset parameters not allowed", { status: 400 });
		}
		if (requestedOffset !== undefined && !/^(-1|now|\d+_\d+)$/.test(requestedOffset)) {
			return new Response("Invalid offset format", { status: 400 });
		}
		if ((live === "long-poll" || live === "sse") && requestedOffset === undefined) {
			return new Response(`${live} requires offset parameter`, { status: 400 });
		}
		if (live === "sse") {
			return handleSseRead(store, url, request);
		}

		const offsetParam = requestedOffset ?? "-1";
		if (offsetParam === "now" && live !== "long-poll") {
			return new Response(isJsonContentType(current.contentType) ? "[]" : null, {
				status: 200,
				headers: cleanHeaders({
					"content-type": current.contentType,
					[STREAM_NEXT_OFFSET]: current.currentOffset,
					[STREAM_UP_TO_DATE]: "true",
					[STREAM_CLOSED]: streamClosedHeader(current),
					"cache-control": "no-store",
				}),
			});
		}
		const offset = offsetParam === "now" ? current.currentOffset : offsetParam;

		let { messages, upToDate } = store.read(url.pathname, offset);
		store.touchAccess(url.pathname);

		if (live === "long-poll" && messages.length === 0 && offset === current.currentOffset) {
			if (current.closed) {
				return new Response(null, {
					status: 204,
					headers: cleanHeaders({
						[STREAM_NEXT_OFFSET]: current.currentOffset,
						[STREAM_CURSOR]: responseCursor(url.searchParams.get("cursor")),
						[STREAM_UP_TO_DATE]: "true",
						[STREAM_CLOSED]: "true",
					}),
				});
			}

			const waited = await store.waitForMessages(url.pathname, offset, 1_000);
			messages = waited.messages;
			upToDate = true;
			store.touchAccess(url.pathname);

			if (waited.streamClosed || waited.timedOut || messages.length === 0) {
				const latest = store.get(url.pathname);
				return new Response(null, {
					status: 204,
					headers: cleanHeaders({
						[STREAM_NEXT_OFFSET]: offset,
						[STREAM_CURSOR]: responseCursor(url.searchParams.get("cursor")),
						[STREAM_UP_TO_DATE]: "true",
						[STREAM_CLOSED]: waited.streamClosed || latest?.closed ? "true" : undefined,
						"content-type": current.contentType,
					}),
				});
			}
		}

		const latest = store.get(url.pathname);
		const lastMessage = messages[messages.length - 1];
		const responseOffset = lastMessage?.offset ?? latest?.currentOffset ?? current.currentOffset;
		const body = store.formatResponse(url.pathname, messages);

		return new Response(toArrayBuffer(body), {
			status: 200,
			headers: cleanHeaders({
				"content-type": current.contentType,
				[STREAM_NEXT_OFFSET]: responseOffset,
				[STREAM_CURSOR]: live === "long-poll" ? responseCursor(url.searchParams.get("cursor")) : undefined,
				[STREAM_UP_TO_DATE]: upToDate ? "true" : undefined,
				[STREAM_CLOSED]: latest?.closed && streamAtTail(latest, responseOffset) && upToDate ? "true" : undefined,
				etag: `"${Buffer.from(url.pathname).toString("base64")}:${offset}:${responseOffset}${latest?.closed ? ":c" : ""}"`,
			}),
		});
	}

	function handleSseRead(store: Store, url: URL, request: Request): Response {
		const stream = store.get(url.pathname);
		if (!stream) {
			return new Response("Stream not found", { status: 404 });
		}

		const initialOffset =
			url.searchParams.get("offset") === "now" ? stream.currentOffset : url.searchParams.get("offset")!;
		const cursor = url.searchParams.get("cursor");
		const contentType = stream.contentType;
		const useBase64 = !isSseTextCompatible(contentType);
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();

		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				let offset = initialOffset;
				try {
					while (!request.signal.aborted) {
						const latest = store.get(url.pathname);
						if (!latest) {
							controller.error(new Error("Stream not found"));
							return;
						}

						const { messages, upToDate } = store.read(url.pathname, offset);
						store.touchAccess(url.pathname);

						for (const message of messages) {
							const data = isJsonContentType(contentType)
								? store.formatResponse(url.pathname, [message])
								: message.data;
							const payload = useBase64 ? Buffer.from(data).toString("base64") : decoder.decode(data);
							controller.enqueue(encoder.encode(encodeSseEvent("data", payload)));
							offset = message.offset;

							const current = store.get(url.pathname);
							controller.enqueue(
								encoder.encode(
									encodeSseEvent(
										"control",
										JSON.stringify({
											streamNextOffset: offset,
											streamCursor: responseCursor(cursor),
											upToDate: upToDate && streamAtTail(current, offset),
											streamClosed: current?.closed && streamAtTail(current, offset),
										}),
									),
								),
							);
						}

						const current = store.get(url.pathname);
						if (current?.closed && streamAtTail(current, offset)) {
							if (messages.length === 0) {
								controller.enqueue(
									encoder.encode(
										encodeSseEvent(
											"control",
											JSON.stringify({
												streamNextOffset: offset,
												streamCursor: responseCursor(cursor),
												upToDate: true,
												streamClosed: true,
											}),
										),
									),
								);
							}
							break;
						}

						if (messages.length > 0) continue;

						const waited = await store.waitForMessages(url.pathname, offset, 1_000);
						if (waited.timedOut || waited.streamClosed) {
							controller.enqueue(
								encoder.encode(
									encodeSseEvent(
										"control",
										JSON.stringify({
											streamNextOffset: offset,
											streamCursor: responseCursor(cursor),
											upToDate: true,
											streamClosed: waited.streamClosed,
										}),
									),
								),
							);
						}
					}
					controller.close();
				} catch (error) {
					controller.error(error);
				}
			},
			cancel() {
				// The client may cancel a live SSE stream; pending waits naturally time out.
			},
		});

		return new Response(body, {
			status: 200,
			headers: cleanHeaders({
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				[STREAM_SSE_DATA_ENCODING]: useBase64 ? "base64" : undefined,
			}),
		});
	}

	async function handleAppend(store: Store, path: string, request: Request): Promise<Response> {
		const contentType = request.headers.get("content-type") ?? undefined;
		const body = new Uint8Array(await request.arrayBuffer());
		const closeStream = request.headers.get(STREAM_CLOSED) === "true";
		if (body.length === 0 && !closeStream) {
			return new Response("Empty body", { status: 400 });
		}
		if (body.length > 0 && !contentType) {
			return new Response("Content-Type header is required", { status: 400 });
		}

		const seq = request.headers.get(STREAM_SEQ) ?? undefined;
		const producerId = request.headers.get(PRODUCER_ID) ?? undefined;
		const producerEpoch = readIntegerHeader(request.headers, PRODUCER_EPOCH);
		const producerSeq = readIntegerHeader(request.headers, PRODUCER_SEQ);

		const hasAnyProducerHeader = producerId !== undefined || producerEpoch !== undefined || producerSeq !== undefined;
		const hasAllProducerHeaders =
			producerId !== undefined && producerEpoch !== undefined && producerSeq !== undefined;

		if (hasAnyProducerHeader && !hasAllProducerHeaders) {
			return new Response("All producer headers must be provided together", {
				status: 400,
			});
		}
		if (producerId === "") {
			return new Response("Invalid Producer-Id: must not be empty", { status: 400 });
		}

		if (body.length === 0 && closeStream) {
			if (hasAllProducerHeaders) {
				const result = await store.closeStreamWithProducer(path, {
					producerId,
					producerEpoch,
					producerSeq,
				});
				if (!result) return new Response("Stream not found", { status: 404 });
				if (result.producerResult) {
					const producerResponse = toProducerResponse(result.producerResult, producerEpoch, producerSeq);
					if (producerResponse) return producerResponse;
				}
				return new Response(null, {
					status: 204,
					headers: cleanHeaders({
						[STREAM_NEXT_OFFSET]: result.finalOffset,
						[STREAM_CLOSED]: "true",
						[PRODUCER_EPOCH]: String(producerEpoch),
						[PRODUCER_SEQ]: String(producerSeq),
					}),
				});
			}

			const result = store.closeStream(path);
			if (!result) return new Response("Stream not found", { status: 404 });
			return new Response(null, {
				status: 204,
				headers: cleanHeaders({
					[STREAM_NEXT_OFFSET]: result.finalOffset,
					[STREAM_CLOSED]: "true",
				}),
			});
		}

		const result: StoreAppendResult = hasAllProducerHeaders
			? await store.appendWithProducer(path, body, {
					seq,
					contentType,
					producerId,
					producerEpoch,
					producerSeq,
					close: closeStream,
				})
			: await store.append(path, body, { seq, contentType, close: closeStream });
		store.touchAccess(path);

		if (isAppendResult(result) && result.producerResult) {
			const producerResponse = toProducerResponse(result.producerResult, producerEpoch, producerSeq);
			if (producerResponse) {
				return producerResponse;
			}
		}

		const message = isAppendResult(result) ? result.message : result;
		if (!message) {
			const current = store.get(path);
			return new Response("Stream is closed", {
				status: 409,
				headers: cleanHeaders({
					[STREAM_CLOSED]: "true",
					[STREAM_NEXT_OFFSET]: current?.currentOffset,
				}),
			});
		}

		return new Response(null, {
			status: hasAllProducerHeaders ? 200 : 204,
			headers: cleanHeaders({
				[STREAM_NEXT_OFFSET]: message?.offset,
				[STREAM_CLOSED]: closeStream ? "true" : undefined,
				...(hasAllProducerHeaders
					? {
							[PRODUCER_EPOCH]: String(producerEpoch),
							[PRODUCER_SEQ]: String(producerSeq),
						}
					: {}),
			}),
		});
	}

	function handleDelete(store: Store, path: string): Response {
		const deleted = store.delete(path);
		if (!deleted) {
			return new Response("Stream not found", { status: 404 });
		}
		return new Response(null, { status: 204 });
	}

	function _fetchFn(store: Store): typeof globalThis.fetch {
		return async (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			const url = new URL(request.url);
			const method = request.method.toUpperCase();

			if (url.origin !== internalOrigin) {
				return new Response(`Unexpected internal fetch URL: ${request.url}`, {
					status: 500,
				});
			}

			try {
				switch (method) {
					case "PUT":
						return await handleCreate(store, url.pathname, request);
					case "HEAD":
						return handleHead(store, url.pathname);
					case "GET":
						return await handleRead(store, url, request);
					case "POST":
						return await handleAppend(store, url.pathname, request);
					case "DELETE":
						return handleDelete(store, url.pathname);
					default:
						return new Response("Method not allowed", { status: 405 });
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);

				if (message.includes("not found")) {
					return new Response("Stream not found", { status: 404 });
				}
				if (message.includes("different configuration")) {
					return new Response("Stream already exists with different config", {
						status: 409,
					});
				}
				if (message.includes("Content-type mismatch")) {
					return new Response("Content-type mismatch", { status: 409 });
				}
				if (message.includes("Sequence conflict")) {
					return new Response("Sequence conflict", { status: 409 });
				}
				if (message.includes("Invalid JSON")) {
					return new Response("Invalid JSON", { status: 400 });
				}
				if (message.includes("Empty arrays are not allowed")) {
					return new Response("Empty arrays are not allowed", { status: 400 });
				}
				if (message.startsWith("Invalid ")) {
					return new Response(message, { status: 400 });
				}

				return new Response(message, { status: 500 });
			}
		};
	}

	function fetchForStore(store: Store): typeof globalThis.fetch {
		const cached = fetchCache.get(store);
		if (cached) return cached;
		const fetchFn = _fetchFn(store);
		fetchCache.set(store, fetchFn);
		return fetchFn;
	}

	export async function reader(topic: string, input: ReaderInput = {}): Promise<ReaderHandle> {
		const s = await resolveStore(input.store ?? memoryStore);
		const fetchFn = fetchForStore(s);
		const streamUrl = new URL(topic, internalOrigin).toString();

		const durableStream = new DurableStream({
			url: streamUrl,
			contentType: "application/json",
			fetch: fetchFn,
		});
		await durableStream.create();

		return {
			url: streamUrl,
			fetch: fetchFn,
			client: durableStream,
		};
	}

	export async function create(topic: string, input: CreateInput): Promise<Handle> {
		const stream = await reader(topic, {
			store: input.store,
		});

		let appendError: Error | undefined;
		const producer = new IdempotentProducer(stream.client, input.producerId, {
			autoClaim: true,
			fetch: stream.fetch,
			onError(error) {
				appendError = error;
				input.onError?.(error);
			},
		});

		return {
			...stream,
			producer,
			async append(payload) {
				appendError = undefined;
				producer.append(JSON.stringify(payload));
				await producer.flush();
				if (appendError) {
					const error = appendError;
					appendError = undefined;
					throw error;
				}
			},
			flush() {
				return producer.flush();
			},
			detach() {
				return producer.detach();
			},
		};
	}
}
