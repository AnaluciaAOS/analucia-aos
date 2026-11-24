# E_WRONG_PLACE

Who acts: `owner`

## What happened

A command of the owner (`aos init`, `sign`, `halt`, `resume`, `repair-log`, `permissions apply`, `ceo import`, or a launcher) printed the name of the project it runs in and stopped, changing nothing: the folder is not the root of a project, or it is another project than the one the launcher or the command was written for (OBS-210).

## What to do next

**Open the window of the project the command was written for (its launcher, or the terminal of that project) and run it there.** (owner)

1. Read the first line it printed: it names the project and the folder where it ran.
2. Go to the folder of the project you meant; click its launcher or open its terminal there.

## Patterns

- A launcher and a command given by the plugin end in `--project <name>`: the code of the project, or its folder name.
- `aos init` runs in a folder that is not a project yet; it only stops on a launcher of another project.

## Trade-offs

- Renaming the folder of a project that has no code makes its old launchers stop; installing them again writes the new name.

## Gotchas

- Nothing is written before the check: the log and the project files stay as they were.
