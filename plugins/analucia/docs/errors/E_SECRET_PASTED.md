# E_SECRET_PASTED

Who acts: `director`

## What happened

`aos drafts` found a line in the draft (the order or the request file) that asks the owner to paste, type or send a key, token, password or secret. The phrases are checked in five languages (English, Spanish, Portuguese, Hindi, Chinese) (OBS-209). The message names the line.

## What to do next

**Take the text that asks the owner for a key, token, password or secret out of the draft, then run aos drafts again.** (director)

1. Wrong: "paste the API key here".
2. Right: the owner signs in on the provider's own page, or the tool reads the value from where it already is; the draft says which.

## Patterns

- A verb that hands something over (paste, type, send, share) within a few words of key, token, password or secret is refused.

## Trade-offs

- A sentence that only talks about the rule ("never ask the owner to paste a key") also matches; rephrase it without the verb and the noun side by side.

## Gotchas

- Nobody ever pastes a secret into a chat, a file or a form of this project.
