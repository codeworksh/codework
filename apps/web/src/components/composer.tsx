import type { ReactNode } from "react";

import { isMac } from "@codeworksh/widget/view";

/** How a send was asked for: `alternate` is Mod+Enter, which a caller may give its own meaning. */
export interface Submit {
	readonly alternate: boolean;
}

/**
 * The prompt card: a textarea that grows with its text, actions at its bottom right, and an
 * optional tray tucked under it. Enter sends, Shift+Enter breaks the line, Mod+Enter sends with
 * `alternate`.
 */
export function Composer({
	value,
	onChange,
	onSubmit,
	placeholder,
	autoFocus,
	actions,
	tray,
}: {
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly onSubmit: (submit: Submit) => void;
	readonly placeholder: string;
	readonly autoFocus?: boolean;
	readonly actions: ReactNode;
	readonly tray?: ReactNode;
}) {
	return (
		<div className="w-full">
			<form
				className="relative z-10 flex flex-col rounded-[22px] border border-edge bg-frame shadow-[0_12px_28px_-18px_rgb(0_0_0/0.4)] transition-colors focus-within:border-edge-focus"
				onSubmit={(event) => {
					event.preventDefault();
					onSubmit({ alternate: false });
				}}
			>
				<div className="px-4 pt-4 pb-2">
					<textarea
						autoFocus={autoFocus}
						rows={1}
						value={value}
						onChange={(event) => onChange(event.target.value)}
						onKeyDown={(event) => {
							// An IME composition owns its own Enter.
							if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
							event.preventDefault();
							onSubmit({ alternate: isMac ? event.metaKey : event.ctrlKey });
						}}
						placeholder={placeholder}
						aria-label="Prompt"
						// Grows with its text from four lines up to about nine, then scrolls.
						className="block max-h-52 min-h-17.5 w-full resize-none bg-transparent text-[14px] leading-relaxed text-ink outline-none [field-sizing:content] placeholder:text-ink-muted/60"
					/>
				</div>
				<div className="flex items-center justify-end gap-2 px-4 pb-4">{actions}</div>
			</form>
			{tray !== undefined && (
				// Inset from the card's rounded corners, tucked under its bottom edge.
				<div className="mx-5.5 -mt-4 flex items-center gap-2 rounded-b-[16px] border border-edge bg-frame/60 px-2 pt-5 pb-1 text-[12px] text-ink-muted/70">
					{tray}
				</div>
			)}
		</div>
	);
}

/** The round primary action at the composer's corner. */
export function ComposerButton({
	label,
	disabled,
	onClick,
	children,
}: {
	readonly label: string;
	readonly disabled?: boolean;
	/** Without it the button submits the form. */
	readonly onClick?: () => void;
	readonly children: ReactNode;
}) {
	return (
		<button
			type={onClick === undefined ? "submit" : "button"}
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
			className="grid size-8 place-items-center rounded-full bg-brand text-brand-ink shadow-xs transition-[opacity,scale] duration-150 enabled:hover:scale-105 disabled:opacity-30"
		>
			{children}
		</button>
	);
}
