# cc-todo

A Claude Code plugin that keeps a todo list and a markdown note for each session, in a pane beside the chat.

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install cc-todo --marketplace zihzihtw/cc-todo
```

## Use

| Command | What it does |
| --- | --- |
| `/todo` | Open the pane on this session's todos |
| `/todo <text>` | Add a todo |
| `/todo note` | Open the Notes tab |
| `/todo all` | List every session's todos and notes |
| `/todo close` | Close the pane |

In the pane:

- **Todo** — click the circle to tick a todo, `✎` to edit it, `×` to remove it, and drag `≡` to reorder. `Hide done` folds finished todos away; `Clear done` deletes them.
- **Notes** — a small markdown editor. The line under the cursor shows its source; every other line is rendered. Edits save as you type.
- **All sessions** — one card per session, named by the title the resume list shows.

The fields are click-to-focus: click one, type, and press Esc to hand the keyboard back to the prompt.

## Where the pane sits

The pane docks to the right of the chat in the fullscreen layout once the terminal is at least 110 columns wide. Otherwise it is drawn above the prompt.

## Data

Todos and notes are kept per session id in the plugin's own store under the Claude Code configuration directory, so `claude --resume` brings a session's list back. Nothing leaves the machine.

Session titles are read from the end of each session's transcript file, which is an internal format: if a future Claude Code changes it, sessions fall back to their first prompt as a name.
