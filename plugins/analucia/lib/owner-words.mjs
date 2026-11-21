// ORD-0043 part 15 (OBS-172) and AMD-0019 section 2: the STOP of the owner wins. A prompt that is only STOP, ALTO,
// DETENER or PARA (any case, with or without punctuation or spaces around it: "para.", "¡Alto!") halts the project,
// through the same function as `aos halt`. A prompt that starts with one of those words and says more ("para qué
// sirve…") is an ordinary prompt: no halt, no record, no context. AVANZA follows the same rule: only the word alone is
// recorded and the session is told to run `aos next`. The record is operation.logged with the word, the session and the
// time of the event; never the rest of the prompt.
import { renderCommands } from './cli.mjs';
import { isHalted, writeHalt } from './guards.mjs';
import { appendEvent } from './log.mjs';
import { sessionName } from './session-names.mjs';

export const STOP_WORDS = ['STOP', 'ALTO', 'DETENER', 'PARA'];
export const GO_WORD = 'AVANZA';

// null, or { word, exact: true, kind }: the whole prompt is one of the owner's words; punctuation, symbols and spaces
// around it do not count. A longer prompt gives null.
export function ownerWord(prompt) {
  if (typeof prompt !== 'string') return null;
  const word = prompt.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toUpperCase();
  const kind = STOP_WORDS.includes(word) ? 'stop' : word === GO_WORD ? 'go' : null;
  return kind ? { word, exact: true, kind } : null;
}

// Acts on the word and returns the one line of context for the session. Never throws: a log that cannot be written
// does not stop the stop.
export function handleOwnerWord(root, input, found, t) {
  const session = typeof input.session_id === 'string' && input.session_id ? input.session_id : null;
  let halted = false;
  const wasHalted = isHalted(root);
  if (found.kind === 'stop') {
    try { halted = writeHalt(root, { reason: `the owner said ${found.word} in the session ${sessionName(root, session)}` }); } catch { halted = isHalted(root); }
  }
  try {
    appendEvent(root, { type: 'operation.logged', actor: 'owner', subject: null, payload: { operation: 'owner.word', word: found.word, session, halted } });
  } catch { /* the word is obeyed even when it cannot be recorded */ }
  const key = found.kind === 'stop' ? 'owner_word.halted' : (wasHalted || isHalted(root) ? 'owner_word.still_halted' : 'owner_word.go');
  return renderCommands(t(key, { word: found.word }));
}
