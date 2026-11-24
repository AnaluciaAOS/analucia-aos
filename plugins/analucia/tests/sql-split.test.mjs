// ORD-0047 part 5 (OBS-207): `aos sql split` ignores semicolons in comments, strings and dollar-quoted bodies; a draft
// that touches a database needs the project's dry run and `aos sql split` in its verify file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { splitSql } from '../lib/sql-split.mjs';
import { touchesDbProblems } from '../lib/drafts.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));

test('semicolons inside comments, strings and dollar bodies do not split', () => {
  const sql = [
    '-- header; with a semicolon',
    'CREATE TABLE a (id int); -- trailing; comment',
    "/* block; comment; */ INSERT INTO a VALUES (1); INSERT INTO a VALUES ('x;y');",
    'CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;',
    'SELECT $tag$ a;b $tag$;',
    '-- only a comment;',
  ].join('\n');
  const s = splitSql(sql);
  assert.equal(s.length, 5);
  assert.match(s[3], /RETURN 1; END;/);
  assert.match(s[2], /'x;y'/);
  assert.deepEqual(splitSql(''), []);
  assert.equal(splitSql('SELECT 1').length, 1);
});

test('aos sql split prints the count and the first line of each; --dry-run changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aos-sql-'));
  const f = join(dir, 'm.sql');
  writeFileSync(f, '-- a; b\r\nCREATE TABLE t (id int);\r\nINSERT INTO t VALUES (1);\r\n');
  const r = spawnSync(process.execPath, [AOS, 'sql', 'split', f, '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /2 statement\(s\)/);
  assert.match(r.stdout, /1\. CREATE TABLE t/);
  assert.match(r.stdout, /2\. INSERT INTO t/);
  assert.equal(spawnSync(process.execPath, [AOS, 'sql', 'split', join(dir, 'none.sql')], { encoding: 'utf8' }).status, 1);
  assert.equal(spawnSync(process.execPath, [AOS, 'sql', 'split'], { encoding: 'utf8' }).status, 2);
});

const order = (extra) => `---\nid: ORD-0001\ntitle: t\nkind: build\n${extra}---\n\n# x\n`;
const verify = (...runs) => JSON.stringify({ order: 'ORD-0001', checks: runs.map((run, i) => ({ name: `c${i}`, run, expect_exit: 0 })) });

test('a draft with touches_db needs the dry run and aos sql split in its verify file', () => {
  const w = 'd.md';
  assert.equal(touchesDbProblems(order(''), verify('true'), w).length, 0);
  assert.equal(touchesDbProblems(order('touches_db: false\n'), verify('true'), w).length, 0);
  const none = touchesDbProblems(order('touches_db: true\n'), verify('true'), w);
  assert.equal(none.length, 2);
  assert.match(none[0], /dry-run/);
  assert.match(none[1], /aos sql split/);
  assert.equal(touchesDbProblems(order('touches_db: true\n'), verify('node scripts/migrate.mjs --dry-run db/001.sql'), w).length, 1);
  assert.equal(touchesDbProblems(order('touches_db: true\n'), verify('node aos.mjs sql split db/001.sql'), w).length, 1);
  assert.equal(touchesDbProblems(order('touches_db: true\n'), verify('node scripts/migrate.mjs --dry-run db/001.sql', 'node aos.mjs sql split db/001.sql'), w).length, 0);
});
