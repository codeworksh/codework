import type { ThemeId } from "../theme";

/** A theme's own colours: its tokens apply under its data-theme, whatever the app's theme is. */
export function Swatch({ theme }: { theme: ThemeId }) {
	return (
		<span
			data-theme={theme}
			aria-hidden
			className="flex h-5 shrink-0 items-center gap-1 border border-(--t-border-strong) bg-(--t-bg) px-1.5 font-sans text-[11px] text-(--t-text)"
		>
			<span className="size-1.5 rounded-full bg-(--t-brand)" />
			Aa
		</span>
	);
}
