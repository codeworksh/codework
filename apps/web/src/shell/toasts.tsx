import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Clone } from "@codeworksh/contract";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast, Toaster } from "sonner";

import { placeAtom } from "../landing/place";
import { cloneDisplayName, cloneProgressSummary, failedAction, useCloneActions, useClones } from "./clones";

const DONE_TIMEOUT = 8_000;

const toastId = (clone: Clone) => `project-clone:${clone.path}`;
const renderKey = (clone: Clone) =>
	`${clone.phase}:${clone.stage}:${clone.percent ?? ""}:${clone.detail ?? ""}:${clone.stalled}:${clone.error ?? ""}`;

/** The app's toasts, and the clones they follow. */
export function Toasts() {
	return (
		<>
			<Toaster
				position="bottom-right"
				toastOptions={{
					classNames: {
						toast: "border-edge! bg-frame! text-ink! shadow-lg!",
						description: "text-ink-muted!",
					},
				}}
			/>
			<CloneToasts />
		</>
	);
}

/**
 * Each clone's progress as a toast, kept current. A clone whose folder is in front on the start
 * page says it there instead, so from then on it toasts only when it fails or is cancelled.
 */
function CloneToasts() {
	const clones = useClones();
	const actions = useCloneActions();
	const setPlace = useAtomSet(placeAtom);
	const navigate = useNavigate();
	const place = useAtomValue(placeAtom);
	const onStart = useLocation({ select: (location) => location.pathname === "/" });
	const rendered = useRef(new Map<string, { key: string; phase: Clone["phase"] }>());
	const silenced = useRef(new Set<string>());

	// Toasts live outside React: each new list renders them again.
	useEffect(() => {
		const shown = rendered.current;
		if (onStart && place.kind === "folder" && clones.some((clone) => clone.path === place.path)) {
			silenced.current.add(place.path);
		}
		for (const clone of clones) {
			const id = toastId(clone);
			const quiet = silenced.current.has(clone.path);
			if (quiet && (clone.phase === "running" || clone.phase === "done")) {
				if (shown.get(clone.path)?.phase !== "done") toast.dismiss(id);
				shown.delete(clone.path);
				continue;
			}
			const key = renderKey(clone);
			if (shown.get(clone.path)?.key === key) continue;
			shown.set(clone.path, { key, phase: clone.phase });
			const name = cloneDisplayName(clone);
			switch (clone.phase) {
				case "running":
					toast.loading(`Cloning ${name}`, {
						id,
						description: cloneProgressSummary(clone),
						duration: Number.POSITIVE_INFINITY,
						action: {
							label: "Cancel",
							onClick: () => void actions.cancel(clone.path).catch(failedAction("Failed to cancel clone")),
						},
					});
					break;
				case "done":
					toast.success(`Cloned ${name}`, {
						id,
						description: clone.path,
						duration: DONE_TIMEOUT,
						action: {
							label: "Open project",
							onClick: () => {
								toast.dismiss(id);
								setPlace({ kind: "folder", path: clone.path });
								void navigate({ to: "/" });
							},
						},
					});
					break;
				case "failed":
				case "cancelled": {
					const failed = clone.phase === "failed";
					(failed ? toast.error : toast.info)(failed ? `Failed to clone ${name}` : `Cancelled cloning ${name}`, {
						id,
						description: failed ? (clone.error ?? "The clone failed.") : clone.path,
						duration: Number.POSITIVE_INFINITY,
						action: {
							label: "Retry",
							onClick: () => void actions.retry(clone.path).catch(failedAction("Failed to retry clone")),
						},
						cancel: {
							label: "Remove project",
							onClick: () => void actions.remove(clone.path).catch(failedAction("Failed to remove project")),
						},
					});
				}
			}
		}
		// A clone gone from the list takes its toast, except a done one, which times out on its own.
		for (const [path, { phase }] of shown) {
			if (clones.some((clone) => clone.path === path)) continue;
			shown.delete(path);
			if (phase !== "done") toast.dismiss(`project-clone:${path}`);
		}
	}, [clones, onStart, place]);

	return null;
}
