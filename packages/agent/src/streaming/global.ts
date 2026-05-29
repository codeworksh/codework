import Type from "typebox";
import { Log } from "../util/log";
import { BusEvent } from "./event";
import { Stream } from "./stream";

export namespace GlobalBus {
	const log = Log.create({ service: "globalbus" });
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
				topic?: string;
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
		publishPayload(payload: BusEvent.Payload): Promise<void[]>;
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

	const states = new Map<string, State>();

	function state(topic: string) {
		let entry = states.get(topic);
		if (!entry) {
			entry = {
				subscriptions: new Map(),
			};
			states.set(topic, entry);
		}
		return entry;
	}

	async function appendStream(entry: State, payload: BusEvent.Payload) {
		if (!entry.stream) return;
		try {
			await entry.stream.append(payload);
		} catch (error) {
			log.warn("stream publish failed", {
				error,
				type: payload.type,
			});
			throw error;
		}
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

	async function initializeStream(entry: State, input: Extract<CreateInput, { stream: true }>) {
		if (entry.stream) {
			if (entry.streamConfig?.topic !== input.topic) {
				throw new Error(
					`Global bus stream already initialized for topic ${entry.streamConfig?.topic}; cannot initialize ${input.topic}`,
				);
			}
			if (entry.streamConfig.producerId !== input.producerId) {
				log.warn("global bus stream already initialized with a different producer id", {
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
		const topic = input.topic ?? "events";
		const entry = state(topic);
		if (input.stream) {
			await initializeStream(entry, input);
		}
		return {
			publish(def, properties) {
				return publishPayloadWithState(entry, {
					type: def.type,
					properties,
				});
			},
			publishPayload(payload) {
				return publishPayloadWithState(entry, payload);
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

	export async function disposeAll() {
		const entries = [...states.values()];
		states.clear();
		await Promise.all(
			entries.map(async (entry) => {
				entry.subscriptions.clear();
				await entry.stream?.detach().catch((error) => {
					log.warn("stream producer detach failed", {
						error,
					});
				});
			}),
		);
	}

	async function publishPayloadWithState(entry: State, payload: BusEvent.Payload) {
		log.info("publishing", {
			type: payload.type,
		});
		await appendStream(entry, payload);
		return notifySubscribers(entry, payload);
	}
}
