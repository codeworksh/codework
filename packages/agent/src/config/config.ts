import { lazy } from "@codeworksh/utils";
import Type, { type Static } from "typebox";
import pkg from "../../package.json" with { type: "json" };

export namespace Config {
	export const Server = Type.Object(
		{
			port: Type.Optional(Type.Integer({ minimum: 1, description: "port to listen on" })),
			hostname: Type.Optional(Type.String({ description: "hostname to listen on" })),
			cors: Type.Optional(
				Type.Array(Type.String(), {
					description: "additional domains to allow for CORS",
				}),
			),
		},
		{ $id: "ServerConfig", additionalProperties: false },
	);

	export const Info = Type.Object({
		server: Type.Optional(Server),
		pkgVersion: Type.String(),
	});

	export type Info = Static<typeof Info>;

	// a thin wrapper for future config, that shall resolve in real
	// read config from local storage and remote
	export const global = lazy(async () => {
		const result: Info = {
			server: {
				port: 4096,
				hostname: "127.0.0.1",
			},
			pkgVersion: pkg.version,
		};
		return Promise.resolve(result);
	});
}
