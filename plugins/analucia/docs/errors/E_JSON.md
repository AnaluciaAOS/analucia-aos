# E_JSON

Who acts: `director`

## What happened

A JSON file or event line does not parse, an event line is empty, or the log's last line has no trailing newline.

## What to do next

**Fix the JSON syntax at the line named in the message (project.json, a verify file, the lock, or one event line).** (director)

1. Owner/director: fix `.analucia/project.json`, verify files or the lock, then `node plugins/analucia/bin/aos.mjs validate`.
2. In the event log: never fix by hand; restore it (see `aos explain E_CHAIN`).
3. `--payload` of `event append`: pass valid JSON in single quotes.

## Patterns

- Generate JSON with a tool rather than by hand.

## Trade-offs

- Strict JSON (no comments, no trailing commas) keeps zero dependencies.

## Gotchas

- In PowerShell, quoting JSON for a native command needs care; prefer Git Bash.
