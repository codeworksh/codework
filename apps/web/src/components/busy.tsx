import { CircleNotchIcon } from "@phosphor-icons/react";

/** A button label that swaps to its working form, a spinner and words, without changing width. */
export function BusyLabel({
	busy,
	idle,
	working,
}: {
	readonly busy: boolean;
	readonly idle: string;
	readonly working: string;
}) {
	return (
		<span className="grid">
			<span className={`col-start-1 row-start-1 ${busy ? "invisible" : ""}`}>{idle}</span>
			<span
				className={`col-start-1 row-start-1 flex items-center justify-center gap-1.5 ${busy ? "" : "invisible"}`}
			>
				<CircleNotchIcon className="animate-spin motion-reduce:animate-none" aria-hidden />
				{working}
			</span>
		</span>
	);
}
