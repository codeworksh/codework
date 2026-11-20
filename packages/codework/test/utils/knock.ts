/* @effect-diagnostics nodeBuiltinImport:off -- a raw upgrade request, as any program on the machine could send. */
import { randomBytes } from "node:crypto";
import { type IncomingHttpHeaders, request } from "node:http";

interface Answer {
	readonly status: number | undefined;
	/** The subprotocol a 101 selected. */
	readonly protocol: string | undefined;
	/** Every response header as sent, to search for what must never be echoed. */
	readonly raw: string;
}

const answer = (status: number | undefined, headers: IncomingHttpHeaders, raw: ReadonlyArray<string>): Answer => ({
	status,
	protocol: headers["sec-websocket-protocol"],
	raw: raw.join("\n"),
});

/** One WebSocket upgrade request to `<host>:<port><path>` with `headers` added, and how it was answered. */
export const knock = (port: number, path: string, headers: Readonly<Record<string, string>>, host = "127.0.0.1") =>
	new Promise<Answer>((resolve, reject) => {
		// A connection of its own: a refused upgrade ends the one it came on.
		const req = request({
			agent: false,
			host,
			port,
			path,
			headers: {
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Version": "13",
				"Sec-WebSocket-Key": randomBytes(16).toString("base64"),
				...headers,
			},
		});
		req.on("upgrade", (response, socket) => {
			socket.destroy();
			resolve(answer(response.statusCode, response.headers, response.rawHeaders));
		});
		req.on("response", (response) => {
			response.resume();
			resolve(answer(response.statusCode, response.headers, response.rawHeaders));
		});
		req.on("error", reject);
		req.end();
	});

/**
 * The upgrade matrix every CodeWork listener answers: the status for each way a request can be
 * wrong, and the right one, given the listener's token and the origins it serves.
 */
export const matrix = async (
	port: number,
	path: string,
	token: string,
	origins: Readonly<Record<string, string>> = {},
) => {
	const protocol = (offered: string) => ({ "Sec-WebSocket-Protocol": offered });
	const status = async (headers: Readonly<Record<string, string>>) => (await knock(port, path, headers)).status;
	const right = protocol(`codework, ${token}`);
	const opened = await knock(port, path, right);
	return {
		"no protocol header": await status({}),
		"fixed name only": await status(protocol("codework")),
		"token first": await status(protocol(`${token}, codework`)),
		"wrong token": await status(protocol(`codework, ${"x".repeat(token.length)}`)),
		"right token, foreign Origin": await status({ ...right, Origin: "https://evil.example" }),
		"right token, Host evil.example": await status({ ...right, Host: `evil.example:${port}` }),
		"right token, Host localhost": await status({ ...right, Host: `localhost:${port}` }),
		...Object.fromEntries(
			await Promise.all(
				Object.entries(origins).map(
					async ([label, origin]) => [label, await status({ ...right, Origin: origin })] as const,
				),
			),
		),
		"right token": opened.status,
		"protocol selected": opened.protocol,
		"token in the response": opened.raw.includes(token),
	};
};
