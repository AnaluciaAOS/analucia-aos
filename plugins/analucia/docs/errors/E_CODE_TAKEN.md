# E_CODE_TAKEN

Who acts: `owner`

## What happened

The project code asked for at `aos init` is already used by another project on this computer. The message names the folder that has it. Nothing was written.

## What to do next

**Choose another project code (2 to 5 capital letters) and answer the code question of aos init again; the message names the folder that already uses this one.** (owner)

1. Double-click INICIAR again (or run `node plugins/analucia/bin/aos.mjs init`) and type another code.
2. If the other folder no longer exists, or is no longer that project, nothing needs to be cleaned: an entry whose folder is gone does not keep its code.

## Patterns

- One code, one project: two projects never share a number, so an ID read alone names its project.

## Trade-offs

- The list is kept per computer (in Claude Code's configuration folder, `CLAUDE_CONFIG_DIR` when it is set). Two computers cannot see each other's codes.

## Gotchas

- A code is never one of the type words `ORD`, `AMD`, `ASK`, `DEC`, `OBS`, `SPEC`.
- A project keeps the code its records carry; it is not changed by a later answer.
