import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Option, Schema } from "effect";
import { ArrowUp, ChevronDown, Folder, FolderPlus } from "lucide-react";
import { useContext, useMemo, useState } from "react";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ComposerNotice } from "@/components/banner";
import { Composer, ComposerButton } from "@/components/composer";
import { makeHost } from "../kernel/host";
import { sessionAddress } from "../widgets/session/address";
import { Json, type Place as Where, topics } from "../widgets/session/schema";
import { useOpenElsewhere } from "../wm/open";
import { ModelPicker, ThinkingPicker, useChoice, useModelsNotice } from "@/components/model";
import { TitleBar } from "../shell/titlebar";
import { placeAtom, placeLabel, usePickFolder } from "./place";
import { projectsAtom } from "../widgets/session/projects";
import { Wordmark } from "./wordmark";

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

	return (
		<div className="flex h-full min-w-0 flex-col select-none">
			<TitleBar active={undefined} />
			<main className="relative flex min-h-0 flex-1 flex-col items-center overflow-auto px-4">
				<div className="flex-[0.8]" />
				<Wordmark className="pointer-events-none w-[min(88%,44rem)] shrink-0 text-brand opacity-15" />
				<div className="mt-10 w-full max-w-2xl shrink-0">
					{notice !== undefined && <ComposerNotice {...notice} />}
					<Composer
						autoFocus
						value={query}
						onChange={setQuery}
						onSubmit={() => void send()}
						placeholder="Ask for changes, send follow-ups, or attach images"
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
						actions={
							<ComposerButton label="Send" disabled={!canSend}>
								<ArrowUp className="size-4" strokeWidth={2} aria-hidden />
							</ComposerButton>
						}
						tray={
							<>
								<DropdownMenu>
									<DropdownMenuTrigger
										title={place.kind === "folder" ? place.path : undefined}
										className="flex h-6 min-w-0 items-center gap-1 rounded-[8px] px-1.75 leading-4 outline-none transition-colors hover:bg-ink/5 hover:text-ink focus-visible:bg-ink/5 data-[state=open]:bg-ink/5 data-[state=open]:text-ink"
									>
										<Folder className="size-3 shrink-0" strokeWidth={1.75} aria-hidden />
										<span className="truncate">{placeLabel(place)}</span>
										<ChevronDown className="size-3 shrink-0 opacity-50" strokeWidth={2} aria-hidden />
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
								{error !== undefined && <span className="truncate px-1.75 py-1 text-destructive">{error}</span>}
							</>
						}
					/>
				</div>
				<div className="flex-1" />
			</main>
		</div>
	);
}
