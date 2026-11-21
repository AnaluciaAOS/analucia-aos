// One closing line on every command the owner runs (ORD-0041 part 6, AMD-0015 §9): on success `OK: <what is now
// true>`, in the owner's language. A failure keeps its error and `next` line; commands read by a program or a hook
// (check-writeback, hook …, next, check-push) print no such line.
export const OK_COMMANDS = ['validate', 'validate_hidden', 'verify_log', 'admit', 'derive', 'launchers', 'launcher_firmar', 'permissions', 'git_hooks', 'ceo_export', 'ceo_import', 'ceo_import_none', 'halt', 'resume', 'sign', 'sign_none', 'repair_log', 'status', 'status_one', 'status_chain', 'status_metric', 'update'];

// t: a catalog function. The prefix is the same in every language, so a person and a check can both find it.
export const okLine = (t, command, facts = {}) => `OK: ${t(`ok.${command}`, facts)}`.replace(/\s*\r?\n\s*/g, ' ');
