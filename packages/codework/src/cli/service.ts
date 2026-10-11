import { Global } from "@codeworksh/harness/effect";
import { Effect, Option } from "effect";
import type { Discovery } from "../server/discovery.ts";

interface Shared {
	readonly userConfigDir: Option.Option<string>;
	readonly home: Option.Option<string>;
	readonly database: Option.Option<string>;
}

/** The CodeWork home the shared flags name, resolved the way the harness resolves it. */
export const home = (shared: Shared) => Global.resolve(Option.isSome(shared.home) ? { home: shared.home.value } : {});

/**
 * How `tui` and `service` find or start the background server: the home whose
 * `service.json` names it, and the server-owned flags it is started with, in the
 * order `serve` parses them.
 */
export const options = (shared: Shared, server: { readonly host: string; readonly port: number }) =>
	home(shared).pipe(
		Effect.map((paths): Discovery.Options => ({
			home: paths.home,
			log: paths.log,
			...server,
			args: [
				...(Option.isSome(shared.home) ? ["--home", shared.home.value] : []),
				...(Option.isSome(shared.database) ? ["--database", shared.database.value] : []),
				...(Option.isSome(shared.userConfigDir) ? ["--user-config-dir", shared.userConfigDir.value] : []),
			],
		})),
	);

export * as Service from "./service.ts";
