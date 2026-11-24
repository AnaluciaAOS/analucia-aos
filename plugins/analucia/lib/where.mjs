// ORD-0047 part 8 (OBS-210): every owner command checks where it is. The owner pasted in the wrong place three times
// (the wrong terminal, the signing of the other project, the director of the other project). So:
//   1. an owner-only command prints first the name of the project it runs in, and stops (E_WRONG_PLACE, nothing changed)
//      when the folder is not the root of a project, or is not the project its launcher was written for (`--project`);
//   2. a command the plugin gives the owner to type says first in which window it goes and carries that same check.
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { aosCommand } from './cli.mjs';
import { projectCode } from './ids.mjs';
import { personLocale } from './locale.mjs';
import { catalog } from './onboarding.mjs';

// Owner-only commands: the first word of the command and, where only one sub-command is the owner's, which one.
export const OWNER_ONLY = { init: null, sign: null, halt: null, resume: null, 'repair-log': null, permissions: 'apply', ceo: 'import' };
export const isOwnerCommand = (cmd, positional = []) => Object.hasOwn(OWNER_ONLY, cmd) && (OWNER_ONLY[cmd] === null || positional[0] === OWNER_ONLY[cmd]);

// The name a launcher carries and a person recognises: the project code when it has one, else the folder name.
export const projectName = (root) => projectCode(root) ?? basename(resolve(root));
export const isProjectRoot = (root) => existsSync(join(root, '.analucia'));

// A launcher cannot carry a space: it writes the name with "_" in its place.
const norm = (n) => String(n).toLowerCase().split(' ').join('_');
const sameName = (a, b) => norm(a) === norm(b);

// { line, problem }: `line` is what is printed first; `problem` (or null) is the sentence that stops the command.
// `init` runs in a folder that is not a project yet: it only stops on a launcher written for another project.
export function whereCheck(root, { command, project = null, locale = personLocale(root) } = {}) {
  const t = catalog(locale);
  const folder = resolve(root).split('\\').join('/');
  const here = isProjectRoot(root);
  const name = projectName(root);
  const line = t('where.project', { name, folder });
  if (!here && command !== 'init') return { line, problem: t('where.not_root', { folder, command: `aos ${command}` }) };
  if (project && ![projectCode(root), basename(resolve(root))].some((n) => n && sameName(n, project))) {
    return { line, problem: t('where.other_project', { expected: project, name, folder }) };
  }
  return { line, problem: null };
}

// The command the owner types: `aos <args> --project <name>`, so the same check stops it in another project.
export const ownerCommand = (root, args) => `${aosCommand()} ${args} --project ${projectName(root)}`;

// The sentence that says, before a command, in which window it goes.
export function whichWindow(root, { launcher = null, locale = personLocale(root) } = {}) {
  const t = catalog(locale);
  return launcher ? t('where.window_launcher', { launcher, name: projectName(root) }) : t('where.window', { name: projectName(root) });
}
