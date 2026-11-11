import { Effect } from "effect";
import * as Runtime from "../../../../framework/runtime.ts";
import * as Discovery from "../../../../server/discovery.ts";
import { reportFailure } from "../../../error.ts";
import * as Service from "../../../service.ts";
import { Cmd } from "../../cmd.ts";

export default Runtime.handler(
	Cmd.commands.service.commands.stop,
	Effect.fn("CLI.service.stop")(function* () {
		const paths = yield* Service.home(yield* Cmd.spec);
		yield* Discovery.stop(paths.home);
	}, Effect.catch(reportFailure)),
);
