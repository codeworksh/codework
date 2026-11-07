import { isMac } from "@codeworksh/widget/view";
import { useState } from "react";

import { Switch } from "@/components/ui/switch";
import { Group, Keys, Page, Row, Section } from "./blocks";
import { Segmented } from "./controls";

export function ChatSettings() {
	const [anchorPrompts, setAnchorPrompts] = useState(true);
	const [expandWorkLog, setExpandWorkLog] = useState(true);
	const [showUsage, setShowUsage] = useState(true);
	const [smoothReveal, setSmoothReveal] = useState(true);
	const [followUpBehavior, setFollowUpBehavior] = useState<"steer" | "followUp">("steer");
	const [spellcheck, setSpellcheck] = useState(true);
	const [emptySession, setEmptySession] = useState<"games" | "minimal">("games");

	return (
		<Page
			title="Chat"
			description="How conversations stream, how the composer handles messages during active runs, and what empty sessions show."
		>
			<Section title="Transcript">
				<Group>
					<Row
						title="Anchor prompts to top"
						description="Place newly sent prompts at the top of the viewport with replies streaming below."
					>
						<Switch
							aria-label="Anchor prompts to top"
							checked={anchorPrompts}
							onCheckedChange={setAnchorPrompts}
						/>
					</Row>
					<Row
						title="Auto-expand work log"
						description="Keep reasoning steps and tool calls open while the agent works, folding once the answer streams."
					>
						<Switch
							aria-label="Auto-expand work log"
							checked={expandWorkLog}
							onCheckedChange={setExpandWorkLog}
						/>
					</Row>
					<Row
						title="Smooth text reveal"
						description="Batch and reveal incoming text and thinking deltas smoothly at frame rate."
					>
						<Switch aria-label="Smooth text reveal" checked={smoothReveal} onCheckedChange={setSmoothReveal} />
					</Row>
					<Row
						title="Show token & cost usage"
						description="Display input, output, cache tokens, and estimated USD cost for each thread."
					>
						<Switch aria-label="Show token & cost usage" checked={showUsage} onCheckedChange={setShowUsage} />
					</Row>
				</Group>
			</Section>

			<Section title="Composer">
				<Group>
					<Row
						title="Active turn send behavior"
						description={
							<>
								Choose what <Keys>Enter</Keys> does while the agent works.{" "}
								<Keys>{isMac ? "⌘Enter" : "Ctrl+Enter"}</Keys> sends the other mode.
							</>
						}
					>
						<Segmented
							label="Active turn send behavior"
							value={followUpBehavior}
							options={[
								{ value: "steer", label: "Steer" },
								{ value: "followUp", label: "Queue" },
							]}
							onChange={setFollowUpBehavior}
						/>
					</Row>
					<Row
						title="Autocorrect & spellcheck"
						description="Enable browser spellcheck and autocorrect in the prompt."
					>
						<Switch aria-label="Autocorrect & spellcheck" checked={spellcheck} onCheckedChange={setSpellcheck} />
					</Row>
				</Group>
			</Section>

			<Section title="Empty Session">
				<Group>
					<Row
						title="Landing experience"
						description="Play arcade games (Dino / Space Invaders) on the start screen or keep it minimal."
					>
						<Segmented
							label="Landing experience"
							value={emptySession}
							options={[
								{ value: "games", label: "Games" },
								{ value: "minimal", label: "Minimal" },
							]}
							onChange={setEmptySession}
						/>
					</Row>
				</Group>
			</Section>
		</Page>
	);
}
