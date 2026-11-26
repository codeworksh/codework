import { RegistryContext, useAtom, useAtomSet } from "@effect/atom-react";
import { Option, Schema } from "effect";
import { CaretDownIcon, FolderIcon } from "@phosphor-icons/react";
import { useContext, useState } from "react";

import { NoticeSlot } from "@/components/banner";
import { Composer, ComposerSubmit } from "@/components/composer";
import { headerTrigger, MachinePicker, useStartMachine } from "@/components/machine";
import { makeHost } from "../kernel/host";
import { sessionAddress } from "../widgets/session/address";
import { useSent } from "../widgets/session/display";
import { handoffs } from "../widgets/session/handoff";
import { Json, type Place as Where, topics } from "../widgets/session/schema";
import { useOpenElsewhere } from "../wm/open";
import { ModelPicker, ThinkingPicker, useChoice, useModelsNotice } from "@/components/model";
import { Arcade } from "./arcade";
import { cloneBlock, useClone, useCloneNotice } from "../shell/clones";
import { useAddProject } from "../shell/palette";
import { machineAtom, placeAtom, placeLabel } from "./place";

const encodeCreate = Schema.encodeSync(Json.Create);
const decodeCreated = Schema.decodeUnknownOption(Json.Created);

// The row of machine and project above the composer: 28px, and 6px to the card.
const ROW = 34;
// The tray that held the project under the composer before the row did.
const TRAY = 30;

/**
 * The start page: pick where to work and send the first prompt. The Session backend creates the
 * session and sends the prompt; the new session then opens in a tab. On failure the text stays.
 */
export function Landing() {
	const registry = useContext(RegistryContext);
	// The start page asks the Session backend as the "landing" source, outside any widget frame.
	const bus = makeHost({ registry, package: "codework", instanceId: "landing" }).bus;
	const openElsewhere = useOpenElsewhere();
	const inFlight = useSent();
	const [query, setQuery] = useState("");
	const [playing, setPlaying] = useState(false);
	const setPicked = useAtomSet(machineAtom);
	const [chosen, setPlace] = useAtom(placeAtom);
	const { machines, machine, machineId } = useStartMachine();
	// A folder belongs to the machine it was picked on; on another one it is not picked. One named by
	// no machine, or by the default one's id, is on the default machine.
	const placeMachine = chosen.kind === "folder" ? (chosen.machineId ?? machines.defaultEntry?.id) : undefined;
	const place =
		chosen.kind === "folder" && machine !== undefined && placeMachine === machine.id
			? chosen
			: ({ kind: "none" } as const);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	// Remembered across restarts; an absent pick leaves it to settings.
	const [choice, setChoice] = useChoice();
	const { model, thinkingLevel: thinking } = choice;
	// A folder's project settings may add models or change the default.
	const hostDir = place.kind === "folder" ? place.path : undefined;
	const notice = useModelsNotice(hostDir, machineId);
	const cloneNotice = useCloneNotice(hostDir, machineId);
	const blocked = cloneBlock(useClone(hostDir, machineId));

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
					...(machineId === undefined ? {} : { machineId }),
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
		// Pending under the main thread's key (its session's id) until its row lands in app.db.
		inFlight.prompt(created.sessionId, prompt.id);
		handoffs.set(created.sessionId, prompt);
		await openElsewhere(sessionAddress(created.sessionId), placeLabel(place), "replace");
	};

	const addProject = useAddProject();

	return (
		<div className="relative flex h-full min-h-0 flex-col overflow-y-auto overscroll-none select-none">
			<Arcade onPlayingChange={setPlaying} />
			<main
				inert={playing}
				className="pointer-events-none relative z-10 mx-auto flex w-full max-w-conversation flex-1 flex-col overflow-clip px-2.5 pt-6 pb-1.5"
			>
				<div aria-hidden className="flex-[1_1_0px]" />
				<div className="pointer-events-auto mb-4 shrink-0 px-2.5">
					<h1 className="truncate text-lg text-ink">What should we work on?</h1>
				</div>
				{/* Where the session runs: physical boundaries, so above the conversation's own controls. */}
				<div className="pointer-events-auto mb-1.5 flex h-7 min-w-0 shrink-0 items-center gap-0.5 px-1">
					{machine === undefined ? (
						// Holds the row while the machines load, so nothing below moves.
						<div className="h-7 w-32" aria-hidden />
					) : (
						<MachinePicker
							machines={machines}
							value={machine}
							onChange={(next) => {
								if (next.id === machine.id) return;
								setPicked(next.isDefault ? undefined : next.id);
								setPlace({ kind: "none" });
							}}
						/>
					)}
					<button
						type="button"
						title={place.kind === "folder" ? place.path : undefined}
						onClick={addProject}
						className={headerTrigger}
					>
						<FolderIcon className="size-3.5 shrink-0" aria-hidden />
						<span className="truncate">{placeLabel(place)}</span>
						<CaretDownIcon className="size-3 shrink-0 text-ink-muted" aria-hidden />
					</button>
					{error !== undefined && <span className="ml-auto truncate text-2xs text-destructive">{error}</span>}
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
									machineId={machineId}
									value={model}
									onChange={(next) => setChoice({ ...choice, model: next })}
								/>
								<ThinkingPicker
									hostDir={hostDir}
									machineId={machineId}
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
					/>
					<NoticeSlot notice={cloneNotice ?? notice} />
				</div>
				{/* The block is centered, so the row above is matched below, on top of the old tray: the card stays put. */}
				<div aria-hidden className="shrink-0" style={{ height: ROW + TRAY }} />
				<div aria-hidden className="flex-[1_1_1.125rem]" />
			</main>
		</div>
	);
}
