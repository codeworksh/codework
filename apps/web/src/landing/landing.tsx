import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Option, Schema } from "effect";
import { ChevronDown, Folder, FolderPlus } from "lucide-react";
import { useContext, useMemo, useState } from "react";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ComposerNotice } from "@/components/banner";
import { PromptComposer, ComposerSubmit } from "@/components/composer";
import { makeHost } from "../kernel/host";
import { sessionAddress } from "../widgets/session/address";
import { Json, type Place as Where, topics } from "../widgets/session/schema";
import { useOpenElsewhere } from "../wm/open";
import { ModelPicker, ThinkingPicker, useChoice, useModelsNotice } from "@/components/model";
import { placeAtom, placeLabel, usePickFolder } from "./place";
import { projectsAtom } from "../widgets/session/projects";

const encodeCreate = Schema.encodeSync(Json.Create);
const decodeCreated = Schema.decodeUnknownOption(Json.Created);

/**
 * The start page: pick where to work and send the first prompt. The Session backend creates the
 * session and sends the prompt; the new session then opens in a workspace. On failure the text stays.
 */
export function Landing() {
	const registry = useContext(RegistryContext);
	// The start page asks the Session backend as the "landing" source, outside any widget frame.
	const bus = useMemo(() => makeHost({ registry, package: "codework", instanceId: "landing" }).bus, [registry]);
	const openElsewhere = useOpenElsewhere();
	const refreshProjects = useAtomRefresh(projectsAtom);
	const [query, setQuery] = useState("");
	const place = useAtomValue(placeAtom);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	// Remembered across restarts; an absent pick leaves it to settings.
	const [choice, setChoice] = useChoice();
	const { model, thinkingLevel: thinking } = choice;
	// A folder's project settings may add models or change the default.
	const hostDir = place.kind === "folder" ? place.path : undefined;
	const notice = useModelsNotice(hostDir);

	const canSend = place.kind !== "none" && query.trim() !== "" && !pending;

	const send = async () => {
		if (!canSend || place.kind !== "folder") return;
		const where: Where = { _tag: "Folder", path: place.path };
		setPending(true);
		setError(undefined);
		const created = await bus
			.request({
				topic: topics.create,
				payload: encodeCreate({
					place: where,
					messageId: crypto.randomUUID(),
					text: query.trim(),
					...(model === undefined ? {} : { model }),
					...(thinking === undefined ? {} : { thinkingLevel: thinking }),
				}),
			})
			.then((reply) => Option.getOrUndefined(decodeCreated(reply.payload)))
			.catch(() => undefined);
		setPending(false);
		if (created?._tag !== "Created") {
			setError(created?.message ?? "The CodeWork server is not reachable.");
			return;
		}
		refreshProjects();
		await openElsewhere(sessionAddress(created.sessionId), placeLabel(place), "replace");
	};

	const pickFolder = usePickFolder();
	const title =
		place.kind === "folder" ? `What should we work on in ${placeLabel(place)}?` : "What should we work on?";

	return (
		<div className="relative flex h-full min-h-0 flex-col overflow-y-auto overscroll-none select-none">
			<main className="relative z-10 mx-auto flex w-full max-w-conversation flex-1 flex-col overflow-clip px-2.5 pt-6 pb-1.5">
				<div aria-hidden className="flex-[1_1_0px]" />
				<div className="mb-4 shrink-0 px-2.5">
					<h1 className="truncate text-lg text-ink" title={place.kind === "folder" ? place.path : undefined}>
						{title}
					</h1>
				</div>
				<div className="w-full shrink-0">
					{notice !== undefined && <ComposerNotice {...notice} />}
					<PromptComposer
						autoFocus
						value={query}
						onChange={setQuery}
						onSubmit={() => void send()}
						placeholder="Describe a task or ask a question…"
						controls={
							<>
								<ModelPicker
									hostDir={hostDir}
									value={model}
									onChange={(next) => setChoice({ ...choice, model: next })}
								/>
								<ThinkingPicker
									hostDir={hostDir}
									model={model}
									value={thinking}
									onChange={(level) => setChoice({ ...choice, thinkingLevel: level })}
								/>
							</>
						}
						actions={<ComposerSubmit label="Start session" disabled={!canSend} />}
						tray={
							<>
								<DropdownMenu>
									<DropdownMenuTrigger
										title={place.kind === "folder" ? place.path : undefined}
										className="group -ml-1.5 flex h-6 min-w-0 max-w-64 items-center gap-1.5 rounded-md px-1.5 text-ui text-ink-muted outline-none press hover:bg-selection hover:text-ink focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-selection data-[state=open]:text-ink"
									>
										<Folder className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
										<span className="truncate">{placeLabel(place)}</span>
										<ChevronDown
											className="size-3 shrink-0 opacity-60 transition-transform group-data-[state=open]:rotate-180"
											strokeWidth={1.75}
											aria-hidden
										/>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="start" className="min-w-44">
										<DropdownMenuLabel>Project</DropdownMenuLabel>
										<DropdownMenuItem
											disabled={pickFolder === undefined}
											onSelect={() => void pickFolder?.()}
										>
											<FolderPlus strokeWidth={1.75} />
											New…
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
								{error !== undefined && (
									<span className="ml-auto truncate text-2xs text-destructive">{error}</span>
								)}
							</>
						}
					/>
				</div>
				<div aria-hidden className="flex-[1_1_1.125rem]" />
			</main>
		</div>
	);
}
