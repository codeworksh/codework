import { Instance } from "../project/instance";
import { Log } from "../util/log";
import { BusEvent } from "./event";
import { GlobalBus } from "./global";

export namespace Bus {
	const log = Log.create({ service: "bus" });
	type Subscription = (event: BusEvent.Payload) => void | Promise<void>;
	type State = {
		subscriptions: Map<string, Subscription[]>;
	};

	export type CreateInput = {
		global?: GlobalBus.Handle;
	};

	export type Handle = {
		publish<Definition extends BusEvent.Definition>(
			def: Definition,
			properties: BusEvent.Payload<Definition>["properties"],
		): Promise<void[]>;
		subscribe<Definition extends BusEvent.Definition>(
			def: Definition,
			sub: (event: BusEvent.Payload<Definition>) => void | Promise<void>,
		): () => void;
		subscribeAll(sub: Subscription): () => void;
	};

	export const InstanceDisposed = GlobalBus.InstanceDisposed;

	const state = Instance.state(
		(): State => {
			const subscriptions = new Map<string, Subscription[]>();

			return {
				subscriptions,
			};
		},
		async (entry) => {
			const event = instanceDisposedPayload();
			await notifySubscribers(entry, event).catch((error) => {
				log.warn("instance dispose subscriber failed", {
					error,
				});
			});
		},
	);

	function instanceDisposedPayload(): BusEvent.Payload<typeof InstanceDisposed> {
		return {
			type: InstanceDisposed.type,
			properties: {
				id: Instance.id,
				directory: Instance.directory,
			},
		};
	}

	function addSubscription(entry: State, key: string, sub: Subscription) {
		const subscriptions = entry.subscriptions.get(key) ?? [];
		subscriptions.push(sub);
		entry.subscriptions.set(key, subscriptions);

		return () => {
			const current = entry.subscriptions.get(key);
			if (!current) return;
			const next = current.filter((item) => item !== sub);
			if (next.length === 0) entry.subscriptions.delete(key);
			else entry.subscriptions.set(key, next);
		};
	}

	function notifySubscribers(entry: State, payload: BusEvent.Payload) {
		const pending: Promise<void>[] = [];
		for (const key of [payload.type, "*"]) {
			const match = entry.subscriptions.get(key);
			for (const sub of match ?? []) {
				pending.push(Promise.resolve(sub(payload)));
			}
		}
		return Promise.all(pending);
	}

	export async function create(input: CreateInput = {}): Promise<Handle> {
		const entry = state();
		return {
			publish(def, properties) {
				return publishWithState(entry, input.global, def, properties);
			},
			subscribe(def, sub) {
				return addSubscription(entry, def.type, sub as Subscription);
			},
			subscribeAll(sub) {
				return addSubscription(entry, "*", sub);
			},
		};
	}

	async function publishWithState<Definition extends BusEvent.Definition>(
		entry: State,
		global: GlobalBus.Handle | undefined,
		def: Definition,
		properties: BusEvent.Payload<Definition>["properties"],
	) {
		const payload: BusEvent.Payload<Definition> = {
			type: def.type,
			properties,
		};
		log.info("publishing", {
			type: def.type,
		});
		const result = await notifySubscribers(entry, payload);
		await global?.publishPayload(payload);
		return result;
	}
}
