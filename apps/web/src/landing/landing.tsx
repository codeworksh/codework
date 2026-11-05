import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Option, Schema } from "effect";
import { Folder } from "lucide-react";
import { useContext, useMemo, useState } from "react";

import { NoticeSlot } from "@/components/banner";
import { Composer, ComposerSubmit } from "@/components/composer";
import { makeHost } from "../kernel/host";
import { sessionAddress } from "../widgets/session/address";
import { handoffs } from "../widgets/session/handoff";
import { Json, type Place as Where, topics } from "../widgets/session/schema";
import { useOpenElsewhere } from "../wm/open";
import { ModelPicker, ThinkingPicker, useChoice, useModelsNotice } from "@/components/model";
import { Arcade } from "./arcade";
import { cloneBlock, useClone, useCloneNotice } from "../shell/clones";
import { useAddProject } from "../shell/palette";
import { placeAtom, placeLabel } from "./place";

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
	const [query, setQuery] = useState("");
	const [playing, setPlaying] = useState(false);
	const place = useAtomValue(placeAtom);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	// Remembered across restarts; an absent pick leaves it to settings.
	const [choice, setChoice] = useChoice();
	const { model, thinkingLevel: thinking } = choice;
	// A folder's project settings may add models or change the default.
	const hostDir = place.kind === "folder" ? place.path : undefined;
	const notice = useModelsNotice(hostDir);
	const cloneNotice = useCloneNotice(hostDir);
	const blocked = cloneBlock(useClone(hostDir));

	const canSend = place.kind !== "none" && query.trim() !== "" && !pending && blocked === undefined;

	const send = async () => {
		if (!canSend || place.kind !== "folder") return;
		const where: Where = { _tag: "Folder", path: place.path };
		setPending(true);
		setError(undefined);
		const prompt = { id: crypto.randomUUID(), text: query.trim(), createdAt: Date.now() };
		const created = await bus
			.request({
				topic: topics.create,
				payload: encodeCreate({
					place: where,
					messageId: prompt.id,
					text: prompt.text,
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
		handoffs.set(created.sessionId, prompt);
		await openElsewhere(sessionAddress(created.sessionId), placeLabel(place), "replace");
	};

	const addProject = useAddProject();
	const title =
		place.kind === "folder" ? `What should we work on in ${placeLabel(place)}?` : "What should we work on?";

	return (
		<div className="relative flex h-full min-h-0 flex-col overflow-y-auto overscroll-none select-none">
			<Arcade onPlayingChange={setPlaying} />
			<main
				inert={playing}
				className="pointer-events-none relative z-10 mx-auto flex w-full max-w-conversation flex-1 flex-col overflow-clip px-2.5 pt-6 pb-1.5"
			>
				<div aria-hidden className="flex-[1_1_0px]" />
				<div className="pointer-events-auto mb-4 shrink-0 px-2.5">
					<h1 className="truncate text-lg text-ink" title={place.kind === "folder" ? place.path : undefined}>
						{title}
					</h1>
				</div>
				<div className="pointer-events-auto relative w-full shrink-0">
					<Composer
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
						actions={
							<ComposerSubmit
								label="Start session"
								disabled={!canSend}
								{...(blocked === undefined ? {} : { title: blocked })}
							/>
						}
						tray={
							<>
								<button
									type="button"
									title={place.kind === "folder" ? place.path : undefined}
									onClick={addProject}
									className="-ml-1.5 flex h-6 min-w-0 max-w-64 items-center gap-1.5 rounded-md px-1.5 text-ui text-ink-muted outline-none press hover:bg-selection hover:text-ink focus-visible:ring-2 focus-visible:ring-ring"
								>
									<Folder className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
									<span className="truncate">{placeLabel(place)}</span>
								</button>
								{error !== undefined && (
									<span className="ml-auto truncate text-2xs text-destructive">{error}</span>
								)}
							</>
						}
					/>
					<NoticeSlot notice={cloneNotice ?? notice} />
				</div>
				<div aria-hidden className="flex-[1_1_1.125rem]" />
			</main>
		</div>
	);
}
