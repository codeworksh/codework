import { Contract } from "@codeworksh/server/contract";
import { Effect, Layer } from "effect";
import { type AsyncResult, type Atom, AtomRegistry, AtomRpc } from "effect/reactivity";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

/**
 * The app server's RPC client as atoms. Electron main hands over the URL; a
 * plain browser has no server, so calls fail and widgets show that instead.
 */
export class Server extends AtomRpc.Service<Server>()("codework/web/Server", {
	group: Contract.Api,
	protocol: RpcClient.layerProtocolSocket().pipe(
		Layer.provide(Socket.layerWebSocket(window.desktopBridge?.server ?? "ws://127.0.0.1:0/rpc")),
		Layer.provide(Socket.layerWebSocketConstructorGlobal),
		Layer.provide(RpcSerialization.layerNdjson),
	),
}) {}

/**
 * Reads a query atom once, fresh, as a promise. Each read mounts the atom only
 * for its duration, so concurrent reads of different atoms never interfere
 * (unlike a shared fn atom, which keeps only the latest call).
 */
export const runQuery = <A, E>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* AtomRegistry.mount(registry, atom);
				// A settled value can be left over from an earlier read; mounting a fresh
				// atom has already started its fetch.
				yield* Effect.sync(() => {
					const current = registry.get(atom);
					if (current._tag !== "Initial" && !current.waiting) registry.refresh(atom);
				});
				return yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
			}),
		),
	);
