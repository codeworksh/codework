import { Effect, Option } from "effect";
import * as Runtime from "../../../framework/runtime.ts";
import * as File from "../../../machine/file.ts";
import * as Relay from "../../../machine/relay.ts";
import { InvalidInputError, reportFailure } from "../../error.ts";
import { writeOut } from "../../output.ts";
import * as Service from "../../service.ts";
import { Cmd } from "../cmd.ts";

export default Runtime.handler(
	Cmd.commands.disconnect,
	Effect.fn("CLI.disconnect")(function* ({ workspace }) {
		const paths = yield* Service.home(yield* Cmd.spec);
		const connected = Option.match(yield* File.read(paths.home), {
			onNone: () => [],
			onSome: (machine) => Object.keys(machine.workspaces),
		});
		const workspaceId = Option.getOrUndefined(workspace) ?? (connected.length === 1 ? connected[0] : undefined);
		if (workspaceId === undefined) {
			return yield* new InvalidInputError({
				message:
					connected.length === 0
						? "This machine is not connected to any workspace"
						: `Connected to ${connected.length} workspaces; name one with --workspace (${connected.join(", ")})`,
			});
		}
		const result = yield* Relay.disconnect(paths.home, workspaceId);
		yield* writeOut(
			result.revoked
				? `Disconnected from ${result.workspace}\n`
				: `Leaving ${result.workspace}: Relay didn’t confirm, so this machine keeps the link until it does. The server retries while it runs.\n`,
		);
	}, Effect.catch(reportFailure)),
);
