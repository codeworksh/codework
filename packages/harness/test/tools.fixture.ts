import type { Message } from "@codeworksh/aikit";

export const pendingCall = (
	name: string,
	arguments_: Record<string, unknown> = {},
	callID = `call-${name}`,
): Message.ToolCallPendingPart => ({
	type: "toolCall",
	callID,
	name,
	arguments: arguments_,
	status: "pending",
	time: { start: 1, end: 1 },
});

/** Syntax that `sh` (dash, ash) rejects: every backend must run it under bash. */
export const BASH_SYNTAX = [
	'arr=(a b c); [[ ${#arr[@]} -eq 3 ]] && echo "array ${arr[1]}"',
	"echo {1..3}",
	"cat <<< here-string",
	`printf 'x=1\\n' > bash-syntax.env && source bash-syntax.env && echo "source x=$x"`,
	'echo "shell ${BASH_VERSION:+bash}"',
].join("; ");
