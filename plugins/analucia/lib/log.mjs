// The event log .analucia/events.jsonl: the only memory (SPEC-0001 §6, Q-75).
// appendEvent is the only writer. It appends exactly one line and never rewrites the file.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuleError, checkRules, replay } from './state.mjs';
import { ulid } from './ulid.mjs';
import { sha256Hex, splitLines, validateEvent } from './validate.mjs';

export const LOG_REL = '.analucia/events.jsonl';
export const logPath = (root) => join(root, '.analucia', 'events.jsonl');

export function readLog(root) {
  const path = logPath(root);
  if (!existsSync(path)) throw new RuleError('E_FILE_MISSING', `${LOG_REL} is missing`);
  const buf = readFileSync(path);
  const { lines, tail } = splitLines(buf);
  const raw = tail ? [...lines, tail] : lines;
  return { path, buf, raw, events: raw.map((r) => JSON.parse(r.toString('utf8'))) };
}

export function readWipLimit(root) {
  const p = join(root, '.analucia', 'project.json');
  if (!existsSync(p)) return 1;
  const v = JSON.parse(readFileSync(p, 'utf8')).wip_limit;
  return Number.isInteger(v) && v >= 1 ? v : 1;
}

// The one timestamp format (ORD-0012): ISO 8601 local time with its offset and milliseconds,
// e.g. 2026-10-20T11:42:07.123-05:00. `timeZone` (IANA, e.g. America/Lima) makes the result independent of the
// machine's clock zone, so a director or a cloud session running in UTC still writes the project's offset.
export function isoWithOffset(date, timeZone) {
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  let y; let mo; let d; let h; let mi; let s; let off;
  if (timeZone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value]));
    [y, mo, d, h, mi, s] = ['year', 'month', 'day', 'hour', 'minute', 'second'].map((k) => Number(parts[k]));
    off = Math.round((Date.UTC(y, mo - 1, d, h, mi, s) - (date.getTime() - date.getMilliseconds())) / 60000);
  } else {
    [y, mo, d, h, mi, s] = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
    off = -date.getTimezoneOffset();
  }
  const sign = off >= 0 ? '+' : '-';
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.trunc(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

// The project's time zone: `timezone` in .analucia/project.json (written by aos init), else the machine's zone.
export function projectTimeZone(root) {
  const p = join(root, '.analucia', 'project.json');
  if (!existsSync(p)) return undefined;
  try {
    const tz = JSON.parse(readFileSync(p, 'utf8')).timezone;
    return typeof tz === 'string' && tz ? tz : undefined;
  } catch {
    return undefined;
  }
}

// Every timestamp the tools write goes through here.
export const timestampFor = (root, date = new Date()) => isoWithOffset(date, projectTimeZone(root));

// Recompute the hash chain. Returns null if intact, else { line, message } for the first broken link.
export function verifyChain(buf) {
  const { lines, tail } = splitLines(buf);
  const raw = tail ? [...lines, tail] : lines;
  if (tail) return { line: raw.length, code: 'E_JSON', message: 'last line is not terminated by "\\n"' };
  for (let i = 0; i < raw.length; i++) {
    let e;
    try {
      e = JSON.parse(raw[i].toString('utf8'));
    } catch (x) {
      return { line: i + 1, code: 'E_JSON', message: `line ${i + 1} is not valid JSON (${x.message})` };
    }
    const expected = i === 0 ? null : sha256Hex(raw[i - 1]);
    if (e === null || typeof e !== 'object' || e.prev !== expected) {
      return {
        line: i + 1,
        code: 'E_CHAIN',
        message: i === 0 ? 'line 1 must have prev null' : `prev does not match sha256 of line ${i} (line ${i} or line ${i + 1} was changed)`,
      };
    }
  }
  return null;
}

// Validate and append one event. Returns { event, line }. Throws RuleError (nothing is written).
// ORD-0019: an append validates only the event it appends and the hash chain (every line is JSON and every
// `prev` matches). It does not reject the log because an earlier event has a type this copy of the plugin does
// not know (an older installed copy reading a log written by a newer one). Full validation stays in
// `aos validate`, `aos verify-log` and `aos verify`.
export function appendEvent(root, { type, actor, subject = null, payload = {}, agent }, { now = new Date(), directorMayClose } = {}) {
  if (!existsSync(logPath(root))) throw new RuleError('E_FILE_MISSING', `${LOG_REL} is missing`);
  const broken = verifyChain(readFileSync(logPath(root)));
  if (broken) throw new RuleError(broken.code, `${LOG_REL} line ${broken.line} is invalid (${broken.message}); run "aos verify-log"`);
  const { path, raw, events } = readLog(root);
  const event = {
    id: ulid(now.getTime()),
    ts: timestampFor(root, now),
    type,
    actor,
    subject,
    payload,
    prev: raw.length ? sha256Hex(raw[raw.length - 1]) : null,
  };
  if (agent !== undefined) event.agent = agent;
  const line = raw.length + 1;
  const errors = validateEvent(event, line);
  if (errors.length) throw new RuleError(errors[0].code, errors.map((x) => `${x.code} ${x.message}`).join('; '));
  checkRules(replay(events), event, { wipLimit: readWipLimit(root), directorMayClose });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { flag: 'a' });
  return { event, line };
}
