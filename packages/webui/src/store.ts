import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

export type AppStoreState = {
	navOpen: boolean;
};

export type AppStoreActions = {
	setNavOpen: (value: boolean) => void;
	toggleNavOpen: () => void;
};

export type AppStore = AppStoreState & AppStoreActions;

export function createAppStore() {
	return createStore<AppStore>()((set) => ({
		navOpen: false,
		setNavOpen: (value) => {
			set({ navOpen: value });
		},
		toggleNavOpen: () => {
			set((state) => ({ navOpen: !state.navOpen }));
		},
	}));
}

export type AppStoreApi = ReturnType<typeof createAppStore>;

export function useAppStore<T>(store: AppStoreApi, selector: (state: AppStore) => T) {
	return useStore(store, selector);
}
