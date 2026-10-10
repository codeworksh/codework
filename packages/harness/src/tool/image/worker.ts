import { Effect } from "effect";
import { parentPort } from "node:worker_threads";
import { REPLY, type Reply, type ResizeOptions, resizeInProcess } from "./resize.ts";

interface Request {
	readonly input: Uint8Array;
	readonly mimeType: string;
	readonly options: ResizeOptions;
}

const port = parentPort;
if (port === null) throw new Error("image resize worker requires parentPort");

port.once("message", (request: Request) => {
	Effect.runPromise(resizeInProcess(request.input, request.mimeType, request.options)).then(
		(result) => port.postMessage({ type: REPLY, result } satisfies Reply),
		(error: unknown) =>
			port.postMessage({
				type: REPLY,
				error: error instanceof Error ? error.message : String(error),
			} satisfies Reply),
	);
});
