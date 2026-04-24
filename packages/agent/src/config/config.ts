import { lazy } from "@codeworksh/utils";
import z from "zod";

export namespace Config {
	export const Server = z
		.object({
			port: z.number().int().positive().optional().describe("port to listen on"),
			hostname: z.string().optional().describe("hostname to listen on"),
			cors: z.array(z.string()).optional().describe("additional domains to allow for CORS"),
		})
		.strict()
		.meta({
			ref: "ServerConfig",
		});

	export const Info = z.object({
		server: Server.optional().describe("server configuration for codework serve and web commands"),
	});

	export type Info = z.output<typeof Info>;

	// a thin wrapper for future config, that shall resolve in real
	// read config from local storage and remote
	export const global = lazy(async () => {
		const result: Info = {
			server: {
				port: 4096,
				hostname: "127.0.0.1",
			},
		};
		return Promise.resolve(result);
	});
}
