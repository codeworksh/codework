import type { Harness } from "@codeworksh/harness/effect";
import DaytonaSandbox from "@codeworksh/harness/sandboxes/daytona";
import VercelSandbox from "@codeworksh/harness/sandboxes/vercel";
import { Option } from "effect";

interface Shared {
	readonly userConfigDir: Option.Option<string>;
	readonly home: Option.Option<string>;
	readonly database: Option.Option<string>;
}

/**
 * The harness boot options every local-harness command builds from the shared
 * flags. `run` and `serve` must agree on the data directory and driver set --
 * a session created by one is expected to be readable by the other.
 */
export const harnessOptions = (shared: Shared): Harness.Options => ({
	...(Option.isNone(shared.userConfigDir) ? {} : { userConfigDir: shared.userConfigDir.value }),
	...(Option.isNone(shared.home) ? {} : { home: shared.home.value }),
	...(Option.isNone(shared.database) ? {} : { database: shared.database.value }),
	sandboxes: [DaytonaSandbox.make({}), VercelSandbox.make({})],
});
