import { Effect, Option } from "effect";
import * as Runtime from "../../../framework/runtime.ts";
import * as Relay from "../../../machine/relay.ts";
import { reportFailure } from "../../error.ts";
import { writeOut } from "../../output.ts";
import * as Service from "../../service.ts";
import { Cmd } from "../cmd.ts";

export default Runtime.handler(
	Cmd.commands.connect,
	Effect.fn("CLI.connect")(
		function* ({ workspace, machineId }) {
			const paths = yield* Service.home(yield* Cmd.spec);
			const connected = yield* Relay.connect({
				home: paths.home,
				workspaceId: Option.getOrUndefined(workspace),
				machineId: Option.getOrUndefined(machineId),
				onCode: (code) => writeOut(`Approve this machine in the CodeWork app with code ${code}\n`),
			});
			yield* writeOut(`Connected to ${connected.workspace.name}\n`);
		},
		Effect.provide(Relay.Client.layer),
		Effect.catch(reportFailure),
	),
);
