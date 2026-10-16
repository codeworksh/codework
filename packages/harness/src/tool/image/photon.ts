import { Effect } from "effect";
import { load as unpacked } from "../../util/unpacked.ts";
import { applyOrientation } from "./exif.ts";

export type Photon = typeof import("@silvia-odwyer/photon-node");
export type PhotonImage = import("@silvia-odwyer/photon-node").PhotonImage;

/** Photon, loaded once on first use; `undefined` when its WASM cannot load, so images degrade instead of failing reads. */
export const load: Effect.Effect<Photon | undefined> = Effect.cached(
	unpacked("@silvia-odwyer/photon-node").pipe(
		Effect.map((module) => module as Photon),
		Effect.orElseSucceed(() => undefined),
	),
).pipe(Effect.runSync);

/** Decode with EXIF orientation applied. The caller frees the result. */
export const decode = (photon: Photon, bytes: Uint8Array): PhotonImage => {
	const raw = photon.PhotonImage.new_from_byteslice(bytes);
	const oriented = applyOrientation(photon, raw, bytes);
	if (oriented !== raw) raw.free();
	return oriented;
};
