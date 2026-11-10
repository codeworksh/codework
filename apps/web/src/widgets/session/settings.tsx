import { useEffect, useRef } from "react";

import { ArrowLeft } from "@/components/vuesax";
import { McpSettings } from "../../settings/mcp";
import { ModelsSettings } from "../../settings/models";
import { PluginsSettings } from "../../settings/plugins";
import { SandboxesSettings } from "../../settings/sandboxes";
import { SkillsSettings } from "../../settings/skills";

/** The sections a project has, one page after another. */
const SECTIONS = [ModelsSettings, McpSettings, SkillsSettings, PluginsSettings, SandboxesSettings];

/** A session's project settings in place of its thread; Esc or the back row returns to the thread. */
export function ProjectSettings({ onBack }: { readonly onBack: () => void }) {
	const scroller = useRef<HTMLDivElement>(null);
	// Takes focus as it opens, so Esc returns from this frame only.
	useEffect(() => scroller.current?.focus({ preventScroll: true }), []);
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex h-8 shrink-0 items-center border-b border-edge/60 px-2">
				<button
					type="button"
					onClick={onBack}
					className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs text-ink-muted outline-none transition-[background-color,color] duration-150 ease-out hover:bg-ink/6 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring"
				>
					<ArrowLeft className="size-3.5" aria-hidden />
					Back to Thread
				</button>
			</div>
			<div
				ref={scroller}
				tabIndex={-1}
				onKeyDown={(event) => {
					if (event.key !== "Escape" || event.defaultPrevented) return;
					event.preventDefault();
					onBack();
				}}
				className="min-h-0 flex-1 overflow-y-auto outline-none"
			>
				{SECTIONS.map((Section, index) => (
					<div key={index} className="border-b border-edge/40 last:border-b-0">
						<Section />
					</div>
				))}
			</div>
		</div>
	);
}
