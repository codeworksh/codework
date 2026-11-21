/* @effect-diagnostics nodeBuiltinImport:off -- a reverse proxy on a real socket, as one in front of a server would be. */
import { createServer, request } from "node:http";
import { connect, type Socket } from "node:net";
import { onTestFinished } from "vite-plus/test";

/** `raw` (`IncomingMessage.rawHeaders`) without any `X-Forwarded-Proto` the client sent, then the proxy's own. */
const forwarded = (raw: ReadonlyArray<string>) => {
	const pairs: Array<[string, string]> = [];
	for (let index = 0; index < raw.length; index += 2)
		if (raw[index]!.toLowerCase() !== "x-forwarded-proto") pairs.push([raw[index]!, raw[index + 1]!]);
	return [...pairs, ["X-Forwarded-Proto", "https"] as [string, string]];
};

/**
 * A TLS-terminating reverse proxy, less the TLS: it listens on loopback and forwards every request
 * and WebSocket upgrade to `target` on loopback, saying `X-Forwarded-Proto: https`, as one that ended
 * TLS would.
 */
export const proxy = async (target: number) => {
	const sockets = new Set<Socket>();
	const track = (socket: Socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	};
	const server = createServer((incoming, outgoing) => {
		const upstream = request(
			{
				host: "127.0.0.1",
				port: target,
				method: incoming.method ?? "GET",
				path: incoming.url ?? "/",
				headers: forwarded(incoming.rawHeaders).flat(),
				agent: false,
			},
			(answer) => {
				outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
				answer.pipe(outgoing);
			},
		);
		upstream.on("error", () => outgoing.destroy());
		incoming.pipe(upstream);
	});
	server.on("connection", track);
	server.on("upgrade", (incoming, socket: Socket, head: Buffer) => {
		const upstream = connect(target, "127.0.0.1", () => {
			const lines = forwarded(incoming.rawHeaders).map(([name, value]) => `${name}: ${value}`);
			upstream.write(`${incoming.method} ${incoming.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
			upstream.write(head);
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		track(upstream);
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	onTestFinished(
		() =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	);
	const address = server.address();
	return { port: typeof address === "object" && address !== null ? address.port : 0 };
};
