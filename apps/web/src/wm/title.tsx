interface TitleProps {
	readonly text: string;
	readonly className?: string;
}

/**
 * Shortens in the middle when space runs out, so the end stays readable:
 * "sk-or-v1-20b…fce". Pure CSS: the head truncates, the tail never shrinks.
 */
export function Title({ text, className = "" }: TitleProps) {
	// Short titles only lose their end; longer ones keep their last 4–8 characters.
	const tail = text.length > 12 ? Math.min(8, Math.max(4, Math.floor(text.length / 4))) : 0;
	return (
		<span className={`flex min-w-0 ${className}`} title={text}>
			<span className="truncate whitespace-pre">{text.slice(0, text.length - tail)}</span>
			{tail > 0 && <span className="shrink-0 whitespace-pre">{text.slice(-tail)}</span>}
		</span>
	);
}
