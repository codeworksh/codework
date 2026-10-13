import { Effect } from "effect";
import { specifier } from "../../util/unpacked.ts";
import { applyOrientation } from "./exif.ts";

export type Photon = typeof import("@silvia-odwyer/photon-node");
export type PhotonImage = import("@silvia-odwyer/photon-node").PhotonImage;

let loading: Promise<Photon | undefined> | undefined;

/** Photon, loaded once on first use; `undefined` when its WASM cannot load, so images degrade instead of failing reads. */
export const load: Effect.Effect<Photon | undefined> = Effect.flatMap(
	specifier("@silvia-odwyer/photon-node"),
	(resolved) =>
		Effect.promise(() => {
			loading ??= (import(resolved) as Promise<Photon>).then(
				(module) => module,
				() => undefined,
			);
			return loading;
		}),
);

/** Decode with EXIF orientation applied. The caller frees the result. */
export const decode = (photon: Photon, bytes: Uint8Array): PhotonImage => {
	const raw = photon.PhotonImage.new_from_byteslice(bytes);
	const oriented = applyOrientation(photon, raw, bytes);
	if (oriented !== raw) raw.free();
	return oriented;
};
