// Sessions named by their role (ORD-0041 part 3). A hook of a plugin can set the title of a session: its output
// `hookSpecificOutput.sessionTitle` on SessionStart and on UserPromptSubmit has the effect of /rename (read in the
// hooks reference and tried on Claude Code 2.1.277 in a scratch configuration). The name comes from the role the
// session declared and from the project: DIRECTOR <project code or folder name> (ORD-0043 part 10: one director per
// project, and the name says which), or EJECUTOR <project code or folder name>. A name a person gave
// is never replaced. DT <topic>, the session of an outside advisor, is named by hand: it is not a role of the plugin.
import { basename, resolve } from 'node:path';
import { projectCode } from './ids.mjs';
import { readLog } from './log.mjs';

export const DIRECTOR_NAME = 'DIRECTOR'; // the first word; alone, it is the name of before ORD-0043 part 10
export const EXECUTOR_PREFIX = 'EJECUTOR';

// True when the session declared the role director under this session id (its latest declaration decides).
export function declaredDirector(root, session, events) {
  if (!session) return false;
  let list = events;
  if (!list) {
    try { list = readLog(root).events; } catch { return false; }
  }
  const mine = list.filter((e) => e.type === 'role.declared' && e.agent?.session === session);
  return mine.at(-1)?.payload?.role === 'director';
}

// The name of a session of this project.
const projectName = (root) => projectCode(root) ?? basename(resolve(root));
export const executorName = (root) => `${EXECUTOR_PREFIX} ${projectName(root)}`;
export const directorName = (root) => `${DIRECTOR_NAME} ${projectName(root)}`;
export function sessionName(root, session, events) {
  return declaredDirector(root, session, events) ? directorName(root) : executorName(root);
}

// A title this plugin gave (so it may replace it when the role changes).
// Only the names this project produces (and the bare DIRECTOR of before): any other title, even one that starts
// the same way, is a person's or another project's.
export const isOwnName = (root, title) => title === DIRECTOR_NAME || title === directorName(root) || title === executorName(root);

// What the hook answers: the title to set, or null when the session already has it or a person named it.
export function titleToSet(root, wanted, current) {
  if (!current) return wanted;
  if (current === wanted) return null;
  // A session named DIRECTOR stays so: a resumed session may come back under another id, with no declaration of its
  // own, and must not be renamed back to an executor (seen in the trial of ORD-0041 part 3).
  if (current === directorName(root)) return null;
  // The bare name of before becomes the name with the project; it is never renamed back to an executor either.
  if (current === DIRECTOR_NAME) return wanted === directorName(root) ? wanted : null;
  return isOwnName(root, current) ? wanted : null;
}

// The hook output for one hook input, or null (print nothing).
export function sessionNameOutput(root, input = {}) {
  const session = typeof input.session_id === 'string' ? input.session_id : null;
  const set = titleToSet(root, sessionName(root, session), typeof input.session_title === 'string' ? input.session_title : '');
  if (!set) return null;
  return { hookSpecificOutput: { hookEventName: typeof input.hook_event_name === 'string' ? input.hook_event_name : 'SessionStart', sessionTitle: set } };
}
