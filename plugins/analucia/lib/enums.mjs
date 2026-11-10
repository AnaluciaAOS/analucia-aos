// Loads the closed lists of SPEC-0001 from core/enums.json (the single machine source).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ENUMS_PATH = fileURLToPath(new URL('../core/enums.json', import.meta.url));
export const enums = JSON.parse(readFileSync(ENUMS_PATH, 'utf8'));

const prefixes = Object.values(enums.record_id_prefixes).join('|');
export const ORDER_ID_RE = /^ORD-\d{4}(\.[A-Z])?$/;
export const RECORD_ID_RE = new RegExp(`^(?:ORD-\\d{4}(?:\\.[A-Z])?|(?:${prefixes})-\\d{4})$`);
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
