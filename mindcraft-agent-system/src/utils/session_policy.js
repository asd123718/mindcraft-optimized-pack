// User policy: commands and goals belong to the current connection only.
// Keep this enforced in the framework, rather than as an opt-in UI default.
export const sessionOnlySettings = Object.freeze({
    load_memory: false,
    init_message: null,
    task: null,
    log_all_prompts: false,
});

export function applySessionPolicy(settings) {
    return Object.assign(settings, sessionOnlySettings);
}
