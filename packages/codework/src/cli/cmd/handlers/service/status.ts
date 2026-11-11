import { Effect } from "effect";
import * as Runtime from "../../../../framework/runtime.ts";
import * as Discovery from "../../../../server/discovery.ts";
import { reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import * as Service from "../../../service.ts";
import { Cmd } from "../../cmd.ts";

export default Runtime.handler(
	Cmd.commands.service.commands.status,
	Effect.fn("CLI.service.status")(function* () {
		const paths = yield* Service.home(yield* Cmd.spec);
		const server = yield* Discovery.discover(paths.home);
		yield* writeOut(`${server?.url ?? "stopped"}\n`);
	}, Effect.catch(reportFailure)),
);
