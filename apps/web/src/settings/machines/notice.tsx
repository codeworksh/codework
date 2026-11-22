import type { RemoteServerStatus } from "@codeworksh/contract";
import { ClockIcon, LinkBreakIcon, ShieldWarningIcon } from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";

import { Button } from "@/components/ui/button";
import { PairAgain } from "./pair";

const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? "" : "s"}`;

/** How far this computer's clock is from the Machine's, for a skew of the Machine's minus this one's. */
const apart = (skew: number) => {
	const minutes = Math.round(Math.abs(skew) / 60_000);
	const amount =
		minutes < 120
			? unit(minutes, "Minute")
			: minutes < 2880
				? unit(Math.round(minutes / 60), "Hour")
				: unit(Math.round(minutes / 1440), "Day");
	return `${amount} ${skew > 0 ? "Behind" : "Ahead"}`;
};

/**
 * What keeps a paired machine from connecting, in one card above its details: not paired, another
 * Machine Key at its address, or clocks apart. Pairing again opens inside the card when it can help.
 */
export function Notice({ server }: { readonly server: RemoteServerStatus }) {
	// Each new problem starts folded, not open from the last one.
	const problem = server.paired ? (server.mismatch?.kind ?? null) : "unpaired";
	return problem === null ? null : <Card key={problem} server={server} />;
}

function Card({ server }: { readonly server: RemoteServerStatus }) {
	const [open, setOpen] = useState(false);
	const { mismatch } = server;
	const content: { icon: ReactNode; title: string; fact: string; keys?: ReactNode } | null = !server.paired
		? {
				icon: <LinkBreakIcon size={16} weight="bold" className="text-ink-muted" />,
				title: "Not Paired",
				fact: "The Machine no longer knows this computer.",
			}
		: mismatch?.kind === "machine"
			? {
					icon: <ShieldWarningIcon size={16} weight="fill" className="text-warning" />,
					title: "Different Machine",
					fact:
						mismatch.fingerprint === null
							? "This address does not answer as the paired Machine. Nothing is sent to it."
							: "This address answers with another Machine Key. Nothing is sent to it.",
					keys: mismatch.fingerprint !== null && (
						<dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
							{server.fingerprint !== null && (
								<>
									<dt className="font-sans text-ink-muted">Paired</dt>
									<dd className="min-w-0 truncate text-ink-muted" title={server.fingerprint}>
										{server.fingerprint}
									</dd>
								</>
							)}
							<dt className="font-sans text-ink-muted">Now</dt>
							<dd className="min-w-0 truncate text-warning" title={mismatch.fingerprint}>
								{mismatch.fingerprint}
							</dd>
						</dl>
					),
				}
			: mismatch?.kind === "clock"
				? {
						icon: <ClockIcon size={16} weight="fill" className="text-warning" />,
						title: `Clock Is ${apart(mismatch.skew)}`,
						fact: "Clocks must agree within 5 minutes. Turn on automatic time on both computers.",
					}
				: null;
	if (content === null) return null;
	// Pairing again takes the key the address answers with; it can't mend clocks.
	const canPair = mismatch?.kind !== "clock";
	return (
		<div role="status" className="-mb-4 flex flex-col rounded-[10px] bg-frame-top shadow-(--cw-card-shadow)">
			<div className="flex items-start gap-3 px-4 py-3.5">
				<span className="mt-0.5 shrink-0" aria-hidden>
					{content.icon}
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="font-medium">{content.title}</span>
					<span className="text-xs font-book text-pretty text-ink-muted">{content.fact}</span>
					{content.keys}
				</div>
				{canPair && !open && (
					<Button size="sm" variant="secondary" className="shrink-0" onClick={() => setOpen(true)}>
						Pair Again…
					</Button>
				)}
			</div>
			{canPair && (
				// Grows open with the rows trick, so the card expands instead of jumping.
				<div
					inert={!open}
					className={`grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
				>
					<div className="overflow-hidden">
						<div className="border-t border-edge/60">{open && <PairAgain server={server} autoFocus />}</div>
					</div>
				</div>
			)}
		</div>
	);
}
