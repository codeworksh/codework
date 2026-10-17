import { type ModelProvider, ThinkingLevel } from "@codeworksh/widget/codework";
import { useAtomValue } from "@effect/atom-react";
import { Command as CommandPrimitive } from "cmdk";
import { Option, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { Brain, ChevronDown, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Server } from "../kernel/rpc";
import { ProviderIcon } from "./provider";

export interface ModelRef {
	readonly provider: string;
	readonly id: string;
}

/** The start page's last model and reasoning picks; absent ones leave it to settings. */
const Choice = Schema.Struct({
	model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
	thinkingLevel: Schema.optionalKey(ThinkingLevel),
});
export type Choice = typeof Choice.Type;
const decodeChoice = Schema.decodeUnknownOption(Schema.fromJsonString(Choice));
const choiceKey = "codework.landing.choice";

function savedChoice(): Choice {
	try {
		return Option.getOrElse(decodeChoice(localStorage.getItem(choiceKey)), () => ({}));
	} catch {
		// Storage can be unavailable; settings decide.
		return {};
	}
}

/** The picks, kept in this window's storage so the start page reopens on them, after a restart too. */
export function useChoice() {
	const [choice, setChoice] = useState<Choice>(savedChoice);
	const update = (next: Choice) => {
		setChoice(next);
		try {
			localStorage.setItem(choiceKey, JSON.stringify(next));
		} catch {
			// The picks still apply until the page closes.
		}
	};
	return [choice, update] as const;
}

/** The models a session in `hostDir` can use; each folder has its own, since its settings may add some. */
const modelsAtom = Atom.family((hostDir: string | undefined) =>
	Server.query("models.list", hostDir === undefined ? {} : { hostDir }),
);

// The composer row's pickers: muted text that brightens on hover, like the prompt's own controls.
const trigger =
	"flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-[8px] px-2.5 outline-none press hover:bg-ink/5 hover:text-ink focus-visible:bg-ink/5 data-[state=open]:bg-ink/5 data-[state=open]:text-ink";

/** A model's name and its provider's, when the list has it. */
const lookup = <P extends ModelProvider>(providers: ReadonlyArray<P>, ref: ModelRef) => {
	const provider = providers.find((candidate) => candidate.id === ref.provider);
	const model = provider?.models.find((candidate) => candidate.id === ref.id);
	return provider === undefined || model === undefined ? undefined : { provider, model };
};

/**
 * Picks the model a new session uses: providers down a rail on the left, their models on the
 * right, and a search across all of them. `value` undefined means settings decide; the trigger
 * then shows the model they pick, muted when this server has no credentials for it.
 */
export function ModelPicker({
	hostDir,
	value,
	onChange,
}: {
	readonly hostDir: string | undefined;
	readonly value: ModelRef | undefined;
	readonly onChange: (model: ModelRef) => void;
}) {
	const result = useAtomValue(modelsAtom(hostDir));
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [rail, setRail] = useState<string>();
	const search = useRef<HTMLInputElement>(null);

	const list = AsyncResult.isSuccess(result) ? result.value : undefined;
	// The providers this server can call, plus the settings default's when it cannot: that one stays
	// in view, unavailable, so the model a session gets by default never silently drops out of sight.
	const providers = useMemo((): ReadonlyArray<ModelProvider & { readonly available: boolean }> => {
		if (list === undefined) return [];
		const usable = list.providers.map((provider) => ({ ...provider, available: true }));
		const fallback = list.default;
		if (lookup(usable, fallback) !== undefined) return usable;
		return [
			...usable.filter((provider) => provider.id !== fallback.provider),
			{
				id: fallback.provider,
				name: fallback.providerName ?? fallback.provider,
				models: [{ id: fallback.id, name: fallback.name ?? fallback.id, thinkingLevels: [] }],
				available: false,
			},
		];
	}, [list]);
	const current = value ?? list?.default;
	const found = current === undefined ? undefined : lookup(providers, current);
	// The rail opens on the current model's provider, or the first one when that has no credentials.
	const shown =
		rail ?? (providers.some((provider) => provider.id === current?.provider) ? current?.provider : providers[0]?.id);

	// Searching looks across every provider; otherwise the list is the rail's provider.
	const needle = query.trim().toLowerCase();
	const rows = useMemo(
		() =>
			providers
				.filter((provider) => needle !== "" || provider.id === shown)
				.flatMap((provider) => provider.models.map((model) => ({ provider, model })))
				// Every word must appear somewhere in the model's name, its id or its provider's name.
				.filter(({ provider, model }) => {
					const text = `${model.name} ${model.id} ${provider.name}`.toLowerCase();
					return needle.split(/\s+/).every((word) => text.includes(word));
				}),
		[providers, needle, shown],
	);

	// The settings default can name a provider this server cannot call; it reads muted, not chosen.
	const unavailable = current !== undefined && list !== undefined && found?.provider.available !== true;
	const label =
		found?.model.name ?? current?.id ?? (AsyncResult.isFailure(result) ? "Models unavailable" : "Choose model");
	const empty = AsyncResult.isFailure(result)
		? "Could not list models."
		: list === undefined
			? "Loading models…"
			: providers.length === 0
				? "No provider is signed in."
				: "No models found";

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					setQuery("");
					setRail(undefined);
				}
			}}
		>
			<PopoverTrigger
				title={
					current === undefined
						? undefined
						: `${current.provider}/${current.id}${unavailable ? " — no credentials on this server" : ""}`
				}
				className={`${trigger} max-w-60`}
			>
				{current !== undefined && (
					<ProviderIcon
						id={current.provider}
						name={found?.provider.name ?? current.provider}
						className="size-4 text-ink-muted"
					/>
				)}
				<span className={`truncate ${unavailable ? "text-ink-muted/60" : ""}`}>{label}</span>
				<ChevronDown className="size-3.5 shrink-0 opacity-60" strokeWidth={2} aria-hidden />
			</PopoverTrigger>
			<PopoverContent
				align="start"
				side="bottom"
				sideOffset={4}
				// Below the composer, flipping above only when it does not fit there.
				collisionPadding={5}
				// Search takes focus on open, not the first provider, so typing filters straight away.
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					search.current?.focus();
				}}
				className="w-90 overflow-hidden rounded-[10px] border-ink/10 bg-popover/85 p-0 shadow-[0_16px_40px_-18px_rgb(0_0_0/0.55)] backdrop-blur-xl"
			>
				<div className="flex max-h-62 min-h-0 flex-row">
					<div
						role="toolbar"
						aria-label="Providers"
						aria-orientation="vertical"
						className="w-11 shrink-0 overflow-y-auto bg-ink/[0.015] p-1 [scrollbar-width:none]"
					>
						<div className="flex flex-col gap-1">
							{providers.map((provider) => {
								const selected = needle === "" && provider.id === shown;
								return (
									<button
										key={provider.id}
										type="button"
										title={
											provider.available ? provider.name : `${provider.name} — no credentials on this server`
										}
										aria-label={provider.name}
										aria-pressed={selected}
										onClick={() => {
											setRail(provider.id);
											setQuery("");
											search.current?.focus();
										}}
										className={`relative flex aspect-square w-full items-center justify-center rounded-lg text-ink transition-colors outline-none hover:bg-ink/10 focus-visible:bg-ink/10 ${provider.available ? "" : "opacity-50"}`}
									>
										<ProviderIcon id={provider.id} name={provider.name} className="size-5" large />
										{selected && (
											<span className="pointer-events-none absolute top-1/2 -right-1 h-5 w-0.75 -translate-y-1/2 rounded-l-full bg-brand" />
										)}
									</button>
								);
							})}
						</div>
					</div>
					<CommandPrimitive
						shouldFilter={false}
						// Opens on the current model, as the highlighted row.
						{...(current === undefined ? {} : { defaultValue: `${current.provider}/${current.id}` })}
						className="flex min-w-0 flex-1 flex-col border-l border-edge/70 bg-ink/[0.025]"
					>
						<div className="px-3 pt-2.5">
							<div className="relative border-b border-edge/70 pb-1.5 transition-colors focus-within:border-brand">
								<Search
									className="pointer-events-none absolute top-1.5 left-0 size-3.5 text-ink-muted"
									strokeWidth={2}
									aria-hidden
								/>
								<CommandPrimitive.Input
									ref={search}
									placeholder="Search models..."
									value={query}
									onValueChange={setQuery}
									className="h-6.5 w-full bg-transparent pl-5 text-sm leading-6.5 text-ink outline-none placeholder:text-ink-muted/70"
								/>
							</div>
						</div>
						<CommandPrimitive.List className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1.5 pr-1.5 pl-2 [scrollbar-width:thin]">
							<CommandPrimitive.Empty className="py-6 text-center text-xs text-ink-muted">
								{empty}
							</CommandPrimitive.Empty>
							<div className="flex flex-col gap-0.5">
								{rows.map(({ provider, model }) => (
									<CommandPrimitive.Item
										key={`${provider.id}/${model.id}`}
										value={`${provider.id}/${model.id}`}
										// Shown so the default stays in view, but a session on it would fail.
										disabled={!provider.available}
										title={
											provider.available ? undefined : `${provider.name} has no credentials on this server`
										}
										onSelect={() => {
											onChange({ provider: provider.id, id: model.id });
											setOpen(false);
										}}
										className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 py-1 outline-none select-none data-[disabled=true]:cursor-not-allowed data-[selected=true]:bg-ink/[0.08]"
									>
										<div className="min-w-0 flex-1">
											<div className="flex min-w-0 items-center gap-2">
												<div
													className={`truncate text-xs leading-snug font-medium ${provider.available ? "text-ink" : "text-ink-muted/60"}`}
												>
													{model.name}
												</div>
											</div>
											<div className="mt-1 flex items-center gap-1.5 text-ink-muted/70">
												<ProviderIcon id={provider.id} name={provider.name} className="size-3" />
												<span className="truncate text-xs leading-snug">{provider.name}</span>
											</div>
										</div>
									</CommandPrimitive.Item>
								))}
							</div>
						</CommandPrimitive.List>
					</CommandPrimitive>
				</div>
			</PopoverContent>
		</Popover>
	);
}

const levelLabels: Record<ThinkingLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra High",
	max: "Max",
};
const ladder = Object.keys(levelLabels) as ReadonlyArray<ThinkingLevel>;

/**
 * The level a run uses for `level` on a model supporting `levels`: the same, else the next one up,
 * else the next one down. The harness clamps the same way; this only shows what it will pick.
 */
const clamp = (level: ThinkingLevel, levels: ReadonlyArray<ThinkingLevel>) => {
	if (levels.includes(level)) return level;
	const at = ladder.indexOf(level);
	return (
		ladder.slice(at + 1).find((candidate) => levels.includes(candidate)) ??
		ladder
			.slice(0, at)
			.reverse()
			.find((candidate) => levels.includes(candidate)) ??
		levels[0]
	);
};

/**
 * Picks how hard the chosen model reasons, among the levels it supports. `value` undefined means
 * settings decide. Always in the row: for a model that does not reason, or one the list cannot
 * call, it reads "Reasoning" and does not open.
 */
export function ThinkingPicker({
	hostDir,
	model,
	value,
	onChange,
}: {
	readonly hostDir: string | undefined;
	readonly model: ModelRef | undefined;
	readonly value: ThinkingLevel | undefined;
	readonly onChange: (level: ThinkingLevel) => void;
}) {
	const result = useAtomValue(modelsAtom(hostDir));
	const list = AsyncResult.isSuccess(result) ? result.value : undefined;
	const current = model ?? list?.default;
	const levels =
		list === undefined || current === undefined ? [] : (lookup(list.providers, current)?.model.thinkingLevels ?? []);
	const picked = useRef<HTMLDivElement>(null);
	// What settings would run this model at, marked so the reader knows what leaving it alone means.
	const fallback = list === undefined ? undefined : clamp(list.default.thinkingLevel, levels);
	const shown = list === undefined ? undefined : clamp(value ?? list.default.thinkingLevel, levels);
	const choosable = shown !== undefined && levels.some((level) => level !== "off");

	return (
		<>
			<span className="mx-0.5 h-4 w-px shrink-0 bg-edge" aria-hidden />
			<DropdownMenu
				// Focus moves to the current level once the menu opens, so it is the one row that reads as picked.
				onOpenChange={(open) => {
					if (open) requestAnimationFrame(() => picked.current?.focus());
				}}
			>
				<DropdownMenuTrigger
					disabled={!choosable}
					className={`${trigger} disabled:cursor-default disabled:text-ink-muted/60 disabled:hover:bg-transparent`}
					title={
						choosable
							? "Reasoning"
							: levels.length === 0
								? "Pick an available model to choose its reasoning"
								: "This model does not reason"
					}
				>
					<Brain className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
					<span className="truncate">{choosable ? levelLabels[shown] : "Reasoning"}</span>
					<ChevronDown className="size-3.5 shrink-0 opacity-60" strokeWidth={2} aria-hidden />
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="start"
					side="bottom"
					sideOffset={4}
					collisionPadding={5}
					className="min-w-36 rounded-[10px] border-ink/10 bg-popover/85 p-1 shadow-[0_16px_40px_-18px_rgb(0_0_0/0.55)] backdrop-blur-xl"
				>
					<DropdownMenuLabel className="px-2 pt-1 pb-0.5 text-xs font-normal text-ink-muted">
						Reasoning
					</DropdownMenuLabel>
					{levels.map((level) => (
						<DropdownMenuItem
							key={level}
							onSelect={() => onChange(level)}
							aria-current={level === shown}
							{...(level === shown ? { ref: picked } : {})}
							className="gap-1.5 rounded-md py-1 text-[13px] aria-current:bg-ink/[0.08]"
						>
							{levelLabels[level]}
							{level === fallback && (
								<span className="rounded-[4px] border border-edge px-1 text-[10px] leading-3.5 text-ink-muted">
									Default
								</span>
							)}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	);
}
