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
	compact = false,
	controls,
	actions,
	tray,
}: {
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly onSubmit: (submit: Submit) => void;
	readonly placeholder: string;
	readonly autoFocus?: boolean;
	/** One line that grows with its text, for a composer sharing a frame with what it talks to. */
	readonly compact?: boolean;
	/** Pickers at the bottom left, such as the model; `actions` sit at the bottom right. */
	readonly controls?: ReactNode;
	readonly actions: ReactNode;
	readonly tray?: ReactNode;
}) {
	return (
		<div className="w-full">
			<form
				// Raised like a frame (the theme's top-down gradient, top highlight and shadows), with a deeper
				// drop so it still floats when it sits inside one.
				className="relative z-10 flex flex-col rounded-[22px] border border-edge bg-linear-to-b from-frame-top to-frame to-60% shadow-[inset_0_1px_0_var(--cw-highlight),0_1px_2px_var(--cw-shadow-near),0_14px_36px_-12px_var(--cw-shadow-far)] transition-colors focus-within:border-edge-focus"
				onSubmit={(event) => {
					event.preventDefault();
					onSubmit({ alternate: false });
				}}
			>
				<div className={compact ? "px-3.5 pt-2.5 pb-0.5" : "px-4 pt-4 pb-2"}>
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
						// Grows with its text, from four lines (one when compact) up to about nine, then scrolls.
						className={`block max-h-52 w-full resize-none bg-transparent text-[14px] leading-relaxed text-ink outline-none [field-sizing:content] placeholder:text-ink-muted/60 ${compact ? "min-h-6" : "min-h-19.5"}`}
					/>
				</div>
				<div className={`flex items-center gap-2 ${compact ? "px-2.5 pb-2.5" : "px-4 pb-4"}`}>
					{/* Pulled left by a control's padding, so the first one's icon lines up with the prompt's text. */}
					<div className="-ml-2.5 flex min-w-0 flex-1 items-center gap-1 text-[14px] font-medium text-ink-muted">
						{controls}
					</div>
					{actions}
				</div>
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
			className="grid size-8 shrink-0 place-items-center rounded-full bg-brand text-brand-ink shadow-xs transition-[opacity,scale,filter] duration-150 ease-out enabled:hover:brightness-110 enabled:active:scale-[0.97] disabled:opacity-64"
		>
			{children}
		</button>
	);
}
