interface TitleProps {
	readonly text: string;
	readonly className?: string;
}

/** Session titles read from the start; hovering reveals the full title when it is shortened. */
export function Title({ text, className = "" }: TitleProps) {
	return (
		<h2 className={`min-w-0 truncate text-ui ${className}`} title={text}>
			{text}
		</h2>
	);
}
