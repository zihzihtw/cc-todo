# cc-todo

A Claude Code plugin that keeps a todo list and a markdown note for each session, in a pane beside the chat.

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install cc-todo --marketplace zihzihtw/cc-todo
```

## Turn on the fullscreen layout

cc-todo is built for Claude Code's fullscreen layout. Turn it on in `~/.claude/settings.json`:

```json
{
  "tui": "fullscreen"
}
```

Without it the pane still works, with less: it is drawn above the prompt instead of beside the chat, the fields are reached from the keyboard and cut long lines short, the note is rendered on save instead of as you type, and todos cannot be dragged.

## Use

| Command | What it does |
| --- | --- |
| `/todo` | Open the pane on this session's todos |
| `/todo <text>` | Add a todo |
| `/todo note` | Open the Notes tab |
| `/todo all` | List every session's todos and notes |
| `/todo close` | Close the pane |

In the pane:

- **Todo** — click the circle to tick a todo, its text to edit it, `×` to remove it, and drag `≡` to reorder. An edit is saved on Enter or by clicking elsewhere in the pane; `cancel` drops it. `Hide done` folds finished todos away; `Clear done` deletes them.
- **Notes** — a small markdown editor. The line under the cursor shows its source; every other line is rendered. Edits save as you type.
- **All sessions** — one card per session, named by the title the resume list shows.

In the fullscreen layout the fields are click-to-focus: click one, type, and press Esc to hand the keyboard back to the prompt. Elsewhere, press ctrl+x then tab to move the keyboard to the pane.

## Where the pane sits

In the fullscreen layout the pane docks to the right of the chat once the terminal is at least 110 columns wide. Below that width it is drawn above the prompt.

## Data

Everything is kept in the plugin's own store, a JSON file under the Claude Code configuration directory on your machine. Nothing is sent anywhere.

For a session that has todos or a note, the store holds:

| Kept | Why |
| --- | --- |
| The todos and the note | Shown in the pane; `claude --resume` brings them back |
| The session's title | Names its card in the All sessions view |
| The name of the folder it runs in | Shown on its card when it differs from the current folder |
| When it was last used | Orders the cards |

The title, folder name and time are refreshed when the session starts, on each prompt and when a todo changes. A session with no todos and no note keeps no record at all.

The title is the one the resume list shows. To get it, the plugin reads the end of the session's transcript file, 256 KiB at a time and no further back than 8 MiB, takes the title from it and keeps that title in its store on your machine. After that it reads only what the session has written since. That file is an internal format, so the title may become unreadable in a future Claude Code: a session with neither a readable title nor one already kept shows as `Untitled session`.

The store is plain text and is never cleaned up by Claude Code, so a session's todos and note stay until you clear them in the pane.

## Develop

Check the plugin as Claude Code will read it, and run its tests:

```sh
claude plugin validate .
claude plugin test .
```

The code is formatted with Prettier, by `.prettierrc.json`.

## License

[MIT](LICENSE)
