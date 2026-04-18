import { create } from "zustand";

export type AppStoreState = {
	navOpen: boolean;
};

export type AppStoreActions = {
	setNavOpen: (value: boolean) => void;
	toggleNavOpen: () => void;
};

export type AppStore = AppStoreState & AppStoreActions;

export const useAppStore = create<AppStore>()((set) => ({
	navOpen: false,
	setNavOpen: (value) => {
		set({ navOpen: value });
	},
	toggleNavOpen: () => {
		set((state) => ({ navOpen: !state.navOpen }));
	},
}));
