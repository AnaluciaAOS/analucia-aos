// Loads the closed lists of SPEC-0001 from core/enums.json (the single machine source).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ENUMS_PATH = fileURLToPath(new URL('../core/enums.json', import.meta.url));
export const enums = JSON.parse(readFileSync(ENUMS_PATH, 'utf8'));

const prefixes = Object.values(enums.record_id_prefixes).join('|');
// ORD-0041 part 1 (AMD-0015 §1): a record ID is written without a project code (ORD-0001, AMD-0001, ASK-0001: every
// existing ID, valid for ever) or with one (<CODE>-0001, <CODE>-AMD-0001, <CODE>-ASK-0001). A code is 2 to 5 capital
// letters and never a type word. Whether a prefix is THIS project's is judged where the project is known (lib/ids.mjs).
export const TYPE_WORDS = ['ORD', 'AMD', 'ASK', 'DEC', 'OBS', 'SPEC'];
export const CODE_PATTERN = `(?!(?:${TYPE_WORDS.join('|')})-)[A-Z]{2,5}`;
export const ORDER_ID_RE = new RegExp(`^(?:ORD|${CODE_PATTERN})-\\d{4}(\\.[A-Z])?$`);
export const ASK_ID_RE = new RegExp(`^(?:${CODE_PATTERN}-)?ASK-\\d{4}$`);
export const RECORD_ID_RE = new RegExp(`^(?:(?:ORD|${CODE_PATTERN})-\\d{4}(?:\\.[A-Z])?|(?:${prefixes})-\\d{4}|${CODE_PATTERN}-(?:AMD|ASK)-\\d{4})$`);
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
