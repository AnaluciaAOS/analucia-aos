# E_OWNER_TTY

Who acts: `owner`

## What happened

An owner-only command (`aos init`, `aos sign`, `aos close`, `aos halt`, `aos resume`, `aos ceo import`) was run without an interactive terminal (stdin is not a TTY), as any agent or pipe runs it. It refused before changing anything.

## What to do next

**Run the command yourself in your own interactive terminal; agents stop here.** (owner)

1. Owner: double-click the launcher of the command in the project folder (INICIAR, FIRMAR, DETENER, REANUDAR, IMPORTAR; anyone writes them with `node plugins/analucia/bin/aos.mjs launchers install`), or open your terminal in the repo and run the command there (for example `node plugins/analucia/bin/aos.mjs close ORD-NNNN`).
2. Agents: do not retry, do not pipe input; report that the step needs the owner.

## Patterns

- Agents prepare; the owner signs.

## Trade-offs

- A TTY check is a practical gate, not cryptographic proof of identity.

## Gotchas

- `echo CLOSE | aos close …` is refused on purpose.
