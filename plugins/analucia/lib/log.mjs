// The event log .analucia/events.jsonl: the only memory (SPEC-0001 §6, Q-75).
// appendEvent is the only writer. It appends exactly one line and never rewrites the file.
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { prefixProblem } from './ids.mjs';
import { RuleError, checkRules, replay } from './state.mjs';
import { ulid } from './ulid.mjs';
import { sha256Hex, splitLines, validateEvent } from './validate.mjs';

export const LOG_REL = '.analucia/events.jsonl';
export const logPath = (root) => join(root, '.analucia', 'events.jsonl');

// ---------- One writer at a time (ORD-0040 part 1) ----------
// Between "read the last line" and "append" there is exactly one process: the one that created the lock file
// (exclusive create). The lock lives for the milliseconds of one append and is never committed.
export const LOG_LOCK_REL = '.analucia/events.jsonl.lock';
export const logLockPath = (root) => join(root, '.analucia', 'events.jsonl.lock');
// How long a writer waits for its turn, and after how long a lock is taken as abandoned whoever holds it.
export const LOCK_WAIT_MS = 10000;
export const LOCK_STALE_MS = 30000;
const BUSY_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']); // Windows answers EPERM/EACCES while a delete is pending

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (x) {
    return x.code === 'EPERM';
  }
};
const defaultWait = () => {
  const raw = process.env.AOS_LOG_LOCK_WAIT_MS;
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? n : LOCK_WAIT_MS;
};

// A lock is abandoned when its process no longer runs on this machine and the lock is older than a normal append
// (a lock released in the normal way is never that old, so a writer that has just finished is not mistaken for a
// dead one), or when it is older than any append can take, whoever holds it.
export const LOCK_DEAD_MS = 1000;
function readStale(path) {
  let text;
  let age;
  try {
    age = Date.now() - statSync(path).mtimeMs;
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let info = null;
  try { info = JSON.parse(text); } catch { /* being written, or not ours: only its age counts */ }
  const dead = info && info.host === hostname() && Number.isInteger(info.pid) && !alive(info.pid);
  return (dead && age > LOCK_DEAD_MS) || age > LOCK_STALE_MS ? text : null;
}

// Removes an abandoned lock. Only one process at a time may remove one (the ".steal" file, exclusive create), it
// judges the lock again once it has that turn, moves it aside, and puts it back if what it moved is not what it
// judged. A ".steal" file left by a process that died is removed by age alone.
function clearStaleLock(path) {
  if (readStale(path) === null) return;
  const steal = `${path}.steal`;
  try {
    closeSync(openSync(steal, 'wx'));
  } catch {
    try {
      if (Date.now() - statSync(steal).mtimeMs > LOCK_STALE_MS) rmSync(steal, { force: true });
    } catch { /* gone */ }
    return;
  }
  try {
    const text = readStale(path);
    if (text === null) return;
    const aside = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
    try { renameSync(path, aside); } catch { return; }
    let moved = null;
    try { moved = readFileSync(aside, 'utf8'); } catch { /* gone */ }
    if (moved !== text) {
      try { linkSync(aside, path); } catch { /* a newer lock exists */ }
    }
    rmSync(aside, { force: true });
  } finally {
    rmSync(steal, { force: true });
  }
}

function acquireLogLock(root, waitMs = defaultWait()) {
  const path = logLockPath(root);
  const token = `${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}`;
  const body = JSON.stringify({ pid: process.pid, host: hostname(), token, at: Date.now() });
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      try { writeSync(fd, body); } finally { closeSync(fd); }
      return token;
    } catch (x) {
      if (!BUSY_CODES.has(x.code)) throw x;
    }
    clearStaleLock(path);
    if (Date.now() >= deadline) {
      throw new RuleError('E_LOG_BUSY', `another process is writing ${LOG_REL} and did not finish within ${waitMs} ms (${LOG_LOCK_REL} is held); nothing was written`);
    }
    sleep(Math.min(40, 2 + attempt * 2) + Math.floor(Math.random() * 6));
  }
}

function releaseLogLock(root, token) {
  const path = logLockPath(root);
  for (let i = 0; i < 20; i++) {
    try {
      if (JSON.parse(readFileSync(path, 'utf8')).token !== token) return; // taken over after the stale age: not ours
      rmSync(path);
      return;
    } catch (x) {
      if (x.code === 'ENOENT' || x instanceof SyntaxError) return;
      sleep(5);
    }
  }
}

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
// ORD-0040 part 1: the whole read-check-append runs under the log lock, so two processes never append with the
// same `prev`. A writer that cannot get its turn within the bounded wait throws E_LOG_BUSY and writes nothing.
export function appendEvent(root, event, { lockWaitMs, ...opts } = {}) {
  if (!existsSync(logPath(root))) throw new RuleError('E_FILE_MISSING', `${LOG_REL} is missing`);
  const token = acquireLogLock(root, lockWaitMs);
  try {
    return appendLocked(root, event, opts);
  } finally {
    releaseLogLock(root, token);
  }
}

function appendLocked(root, { type, actor, subject = null, payload = {}, agent }, { now = new Date(), directorMayClose } = {}) {
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
  // ORD-0041 part 1 (AMD-0015 §1): a new record carries the prefix of this project: its code when it has one, the
  // old prefix when it has none. Existing lines are never judged again.
  if (type === 'record.created') {
    const problem = prefixProblem(root, subject);
    if (problem) throw new RuleError('E_ID_PREFIX', problem);
  }
  checkRules(replay(events), event, { wipLimit: readWipLimit(root), directorMayClose });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { flag: 'a' });
  return { event, line };
}
