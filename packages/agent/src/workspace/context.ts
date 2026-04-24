import { Context } from "../util/context.ts"

interface Context {
    workspaceId: string
}

const context = Context.create<Context>("workspace")

export const WorkspaceContext = {
    async provide<R>(input: { workspaceId: string; fn: () => R }): Promise<R> {
        return context.provide({ workspaceId: input.workspaceId}, async () => {
            return input.fn()
        })
    },

    get workspaceID() {
        try {
            return context.use().workspaceId
        } catch (e) {
            return undefined
        }
    },
}
