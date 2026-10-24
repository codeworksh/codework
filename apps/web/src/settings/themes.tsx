import { useAtom } from "@effect/atom-react";
import { Check } from "lucide-react";

import { isMac } from "@codeworksh/widget/view";
import { THEMES, themeAtom } from "../theme";
import { Keys, Page, Section } from "./blocks";

/** Every theme as a small preview drawn in its own colours; clicking one applies and saves it. */
export function ThemesSettings() {
	const [current, setTheme] = useAtom(themeAtom);

	return (
		<Page
			title="Themes"
			description={
				<>
					The colours of the whole app, saved on this device. <Keys>{isMac ? "⌘K" : "Ctrl+K"}</Keys> also changes
					it from anywhere.
				</>
			}
		>
			<Section title="Theme">
				<div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
					{THEMES.map((theme) => {
						const selected = theme.id === current;
						return (
							<button
								key={theme.id}
								type="button"
								role="radio"
								aria-checked={selected}
								onClick={() => setTheme(theme.id)}
								className="group flex flex-col gap-2 text-left outline-none"
							>
								{/* The theme's own tokens apply under its data-theme. */}
								<span
									data-theme={theme.id}
									className={`flex aspect-16/10 flex-col gap-1.5 border bg-(--t-bg) p-2.5 transition-colors ${
										selected
											? "border-brand ring-1 ring-brand"
											: "border-edge group-hover:border-edge-focus group-focus-visible:border-edge-focus"
									}`}
								>
									<span className="flex flex-1 flex-col gap-1.5 border border-(--t-border-subtle) bg-(--t-surface) p-2">
										<span className="h-1.5 w-3/5 bg-(--t-text)" />
										<span className="h-1.5 w-4/5 bg-(--t-text-muted) opacity-60" />
										<span className="h-1.5 w-2/5 bg-(--t-text-muted) opacity-60" />
									</span>
									<span className="h-2.5 w-1/3 bg-(--t-brand)" />
								</span>
								<span className="flex items-center gap-1.5 text-[13px]">
									{theme.name}
									{selected && <Check className="size-3.5 text-brand" strokeWidth={2} aria-hidden />}
								</span>
							</button>
						);
					})}
				</div>
			</Section>
		</Page>
	);
}
