# E_OTHER_PROJECT

Who acts: `director`

## What happened

A tool call of this session tried to write or delete a file inside the `.analucia/` folder of another project: a `.analucia/` that is not under the root of the project this session works in. The PreToolUse hook blocked it, whatever the role of the session. Nothing was written.

## What to do next

**Open a session in the project that owns the file and write it there: one director per project.** (director)

1. Tell the owner which project the work belongs to.
2. The owner opens a session in the folder of that project; its director writes the draft there (`.analucia/drafts/`), and the owner places it with FIRMAR.
3. In this session, go on with the work of this project only.

## Patterns

- One director per project: a session that declares the role is named `DIRECTOR <project code or folder name>`, so the owner sees whose orders it writes.
- Reading the files of another project stays free: read them, then say what should change there and why.

## Trade-offs

- A scratch project outside this one is "another project" too: build it with a script or a test, or work from a session opened in it.

## Gotchas

- The hook judges the paths a command names. A relative path after a `cd` into another project is not seen; do not use that to write there.
- A folder named `.analucia/` inside this project (a fixture, a sample) is this project's and is not blocked by this rule.
