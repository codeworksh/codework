export interface SidebarMockThread {
	id: string;
	title: string;
	relativeTime: string;
	active?: boolean;
}

export interface SidebarMockProject {
	id: string;
	name: string;
	cwd: string;
	faviconColor: string;
	expanded: boolean;
	threads: SidebarMockThread[];
}

export interface SidebarMockData {
	projects: SidebarMockProject[];
}
