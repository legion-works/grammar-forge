import { startOrchestrator } from "./orchestrator";
import type { TuiApi, TuiPluginModule } from "./opencode-types";

const plugin: TuiPluginModule = {
    id: "grammarforge",
    tui: async (api: TuiApi, options) => {
        const stop = startOrchestrator(api, options);
        api.lifecycle.onDispose(stop);
    },
};

export default plugin;
