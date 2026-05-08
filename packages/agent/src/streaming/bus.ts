import Type from "typebox";
import { Instance } from "../project/instance";
import { Log } from "../util/log";
import { BusEvent } from "./event";
import { Stream } from "./stream";

export namespace Bus {
	const log = Log.create({ service: "bus" });
	type Subscription = (event: BusEvent.Payload) => void | Promise<void>;
	type State = {
		subscriptions: Map<string, Subscription[]>;
		stream?: Stream.Handle;
		streamConfig?: {
			producerId: string;
			topic: string;
		};
	};

	export type CreateInput =
		| {
				stream?: false;
		  }
		| {
				stream: true;
				store?: Stream.StoreInput;
				topic: string;
				producerId: string;
		  };
	export type ReaderInput = {
		store?: Stream.StoreInput;
		topic: string;
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

	export const InstanceDisposed = BusEvent.define(
		"server.instance.disposed",
		Type.Object({
			id: Type.String(),
			directory: Type.String(),
		}),
	);

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
			await appendStream(entry, event);
			await entry.stream?.detach().catch((error) => {
				log.warn("stream producer detach failed", {
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

	async function appendStream(entry: State, payload: BusEvent.Payload) {
		if (!entry.stream) return;
		await entry.stream.append(payload).catch((error) => {
			log.warn("stream publish failed", {
				error,
				type: payload.type,
			});
		});
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
		const pending: (void | Promise<void>)[] = [];
		for (const key of [payload.type, "*"]) {
			const match = entry.subscriptions.get(key);
			for (const sub of match ?? []) {
				pending.push(sub(payload));
			}
		}
		return Promise.all(pending);
	}

	async function initializeStream(entry: State, input: Extract<CreateInput, { stream: true }>) {
		if (entry.stream) {
			if (entry.streamConfig?.topic !== input.topic) {
				throw new Error(
					`Bus stream already initialized for topic ${entry.streamConfig?.topic}; cannot initialize ${input.topic}`,
				);
			}
			if (entry.streamConfig.producerId !== input.producerId) {
				log.warn("bus stream already initialized with a different producer id", {
					currentProducerId: entry.streamConfig.producerId,
					requestedProducerId: input.producerId,
					topic: input.topic,
				});
			}
			return;
		}

		entry.stream = await Stream.create(input.topic, {
			store: input.store ?? Stream.memoryStore,
			producerId: input.producerId,
			onError(error) {
				log.warn("stream producer failed", {
					error,
					topic: input.topic,
					producerId: input.producerId,
				});
			},
		});
		entry.streamConfig = {
			producerId: input.producerId,
			topic: input.topic,
		};
	}

	export async function create(input: CreateInput = {}): Promise<Handle> {
		const entry = state();
		if (input.stream) {
			await initializeStream(entry, input);
		}
		return {
			publish(def, properties) {
				return publishWithState(entry, def, properties);
			},
			subscribe(def, sub) {
				return addSubscription(entry, def.type, sub as Subscription);
			},
			subscribeAll(sub) {
				return addSubscription(entry, "*", sub);
			},
		};
	}

	export async function reader(input: ReaderInput): Promise<Stream.ReaderHandle> {
		return Stream.reader(input.topic, {
			store: input.store ?? Stream.memoryStore,
		});
	}

	function publishWithState<Definition extends BusEvent.Definition>(
		entry: State,
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
		void appendStream(entry, payload);
		return notifySubscribers(entry, payload);
	}
}
