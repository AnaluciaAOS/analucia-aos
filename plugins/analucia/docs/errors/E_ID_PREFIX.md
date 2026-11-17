# E_ID_PREFIX

Who acts: `director`

## What happened

A new record carries a prefix that is not this project's. Either the project has a code (`project_code` in `.analucia/project.json`) and the record still uses the old prefix (`ORD-`, `AMD-`, `ASK-`), or the record carries the code of another project, or the project has no code and the record carries one. Nothing was written. Records that already exist are never affected: their IDs stay valid for ever.

## What to do next

**Give the record the ID named in the message: new records carry the code of the project (aos ids prints the next free ID of each kind).** (director)

1. `node plugins/analucia/bin/aos.mjs ids` prints the code, every existing record and the next free ID of each kind.
2. Rename the draft (the order and its verify file) to that ID, and make the `id` and `order` fields equal the file names.
3. Use the same ID in the commit trailer: `Analucia-Order: <ID>`.

## Patterns

- Orders `<CODE>-NNNN`, amendments `<CODE>-AMD-NNNN`, asks `<CODE>-ASK-NNNN`. Each counter continues from the highest number the project already has.

## Trade-offs

- Old and new IDs live side by side in one project. Nothing signed is ever renumbered, so both forms must be read for ever.

## Gotchas

- A project without a code keeps the old prefix for new records; the owner chooses the code once, with INICIAR.
