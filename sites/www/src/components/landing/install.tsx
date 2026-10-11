import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { hero } from "./content";

export function Install() {
	const [active, setActive] = useState(0);
	const [copied, setCopied] = useState(false);
	const command = hero.install[active]!.command;

	async function copy() {
		await navigator.clipboard.writeText(command);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	}

	return (
		<div className="relative w-full max-w-xl border border-border-strong bg-surface text-left">
			<span className="absolute -top-2 right-3 border border-brand/40 bg-surface px-1.5 font-mono text-[10px] leading-4 tracking-wider text-brand uppercase select-none">
				alpha
			</span>
			<div role="tablist" aria-label="Package manager" className="flex border-b border-border-subtle">
				{hero.install.map((item, i) => (
					<button
						key={item.label}
						type="button"
						role="tab"
						aria-selected={i === active}
						onClick={() => setActive(i)}
						className={`-mb-px border-r border-b-2 border-r-border-subtle px-4 py-2 font-mono text-xs font-medium tracking-wider uppercase transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand ${
							i === active
								? "border-b-brand bg-surface-2 text-text"
								: "border-b-transparent text-text-muted hover:text-text"
						}`}
					>
						{item.label}
					</button>
				))}
			</div>
			<div className="flex items-center gap-3 py-2.5 pr-2.5 pl-4">
				<code className="min-w-0 flex-1 overflow-x-auto font-mono text-sm whitespace-nowrap text-text select-text">
					<span className="text-text-muted select-none">$ </span>
					{command}
				</code>
				<button
					type="button"
					onClick={copy}
					aria-label={copied ? "Copied" : "Copy command"}
					className="inline-flex size-9 shrink-0 items-center justify-center border border-border-subtle text-text-secondary transition-[color,border-color,transform] duration-150 ease-out hover:border-border-strong hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:scale-[0.94] [&_svg]:size-4"
				>
					{copied ? <Check className="text-brand" /> : <Copy />}
				</button>
			</div>
		</div>
	);
}
