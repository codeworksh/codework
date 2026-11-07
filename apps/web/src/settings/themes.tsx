import { Check } from "@/components/vuesax";
import { useAtom } from "@effect/atom-react";

import { isMac } from "@codeworksh/widget/view";
import { THEMES, themeAtom, type ThemeId } from "../theme";
import { Keys, Page } from "./blocks";

/** A miniature session uses the same palette as the full app, independent of the selected theme. */
function ThemePreview({ theme }: { readonly theme: ThemeId }) {
	return (
		<span
			data-theme={theme}
			aria-hidden="true"
			className="flex aspect-16/10 w-full overflow-hidden bg-(--t-bg) p-3 text-(--t-text)"
		>
			<span className="flex w-1/4 shrink-0 flex-col gap-2.5 pt-1 pr-3">
				<span className="mb-2 flex gap-1">
					{[0, 1, 2].map((dot) => (
						<span key={dot} className="size-1 rounded-full bg-(--t-text-muted)/35" />
					))}
				</span>
				<span className="h-1 w-4/5 rounded-full bg-(--t-text-muted)/45" />
				<span className="-mx-1 flex h-4 items-center rounded bg-(--t-text)/8 px-1">
					<span className="h-1 w-3/4 rounded-full bg-(--t-text-secondary)/70" />
				</span>
				<span className="h-1 w-3/5 rounded-full bg-(--t-text-muted)/30" />
				<span className="h-1 w-4/5 rounded-full bg-(--t-text-muted)/30" />
				<span className="mt-auto h-1 w-1/2 rounded-full bg-(--t-text-muted)/30" />
			</span>
			<span className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-(--t-border-subtle) bg-(--t-surface)">
				<span className="flex h-6 shrink-0 items-center border-b border-(--t-border-subtle) px-2.5">
					<span className="h-1 w-12 rounded-full bg-(--t-text-muted)/35" />
				</span>
				<span className="flex flex-1 flex-col justify-center gap-2 px-3 py-3">
					<span className="ml-auto h-5 w-3/4 rounded-md bg-(--t-text)/7" />
					<span className="flex items-center gap-1.5">
						<span className="size-2 shrink-0 rounded-sm bg-(--t-brand)" />
						<span className="h-1 w-1/3 rounded-full bg-(--t-text-secondary)/60" />
					</span>
					<span className="ml-3.5 h-1 w-4/5 rounded-full bg-(--t-text-muted)/30" />
					<span className="ml-3.5 h-1 w-3/5 rounded-full bg-(--t-text-muted)/30" />
				</span>
				<span className="mx-2 mb-2 flex h-7 shrink-0 items-center justify-between rounded-md border border-(--t-border-subtle) bg-(--t-surface-2) px-2">
					<span className="h-1 w-1/2 rounded-full bg-(--t-text-muted)/30" />
					<span className="flex size-3.5 items-center justify-center rounded bg-(--t-brand) text-[10px] leading-none text-(--t-brand-ink)">
						↑
					</span>
				</span>
			</span>
		</span>
	);
}

/** Selecting a theme applies and saves it immediately; native radios provide keyboard navigation. */
export function ThemesSettings() {
	const [current, setTheme] = useAtom(themeAtom);

	return (
		<Page title="Themes" description="Choose how CodeWork looks on this device.">
			<fieldset className="flex max-w-xl flex-col gap-3">
				<legend className="mb-3 text-ui font-medium text-ink">Appearance</legend>
				<div className="grid grid-cols-1 gap-4 @min-[440px]:grid-cols-2">
					{THEMES.map((theme) => {
						const selected = theme.id === current;
						return (
							<label key={theme.id} className="group relative cursor-pointer">
								<input
									type="radio"
									name="appearance"
									value={theme.id}
									checked={selected}
									onChange={() => setTheme(theme.id)}
									aria-label={theme.name}
									className="peer sr-only"
								/>
								<span className="flex overflow-hidden rounded-xl border border-edge shadow-xs group-hover:border-edge-focus peer-checked:border-brand peer-checked:ring-1 peer-checked:ring-brand peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-brand">
									<ThemePreview theme={theme.id} />
								</span>
								<span className="mt-3 flex items-center justify-between gap-3 px-0.5">
									<span className="flex flex-col gap-1">
										<span className="text-ui font-medium text-ink">{theme.name}</span>
										<span className="text-xs text-ink-muted">
											{theme.id === "light" ? "Bright and clear." : "Easy on the eyes."}
										</span>
									</span>
									<span
										aria-hidden="true"
										className="flex size-4 items-center justify-center rounded-full border border-edge group-has-checked:border-transparent group-has-checked:text-brand"
									>
										{selected && <Check className="size-4" />}
									</span>
								</span>
							</label>
						);
					})}
				</div>
			</fieldset>
			<p className="flex max-w-xl flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-edge pt-4 text-xs text-ink-muted">
				Saved on this device. Switch anytime with <Keys>{isMac ? "⌘K" : "Ctrl+K"}</Keys>
			</p>
		</Page>
	);
}
