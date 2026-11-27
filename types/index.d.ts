export type Todo = { id: number; text: string; isDone: boolean }

/**
 * What is kept about a session that has todos or a note, to name it among
 * the others: nothing the pane does not show.
 */
export type SessionNote = {
  // The name of the folder the session runs in, not its path.
  folder: string
  // When the session was last used: started, prompted, or its list changed.
  usedAt: number
  // The title the resume list shows for the session, once it has one.
  name?: string
  // Set where `name` was read from the session's transcript. A record
  // without it holds a name from an earlier version, which is not kept.
  isNameFromTitle?: boolean
  // Whether `name` is one the person gave with /rename, which no generated
  // title replaces.
  isNameCustom?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cc-todo': {
      // Counts the changes made to the stored lists: the pane reads it while
      // drawing, so a change draws it again.
      changes: number
      // Whether the pane lists every session's todos or this session's alone.
      isAllShown: boolean
      // Which tab the pane shows: the todo list or the markdown note.
      tab: 'todo' | 'note'
      // The todo whose text is drawn as a field, as `<session id>:<todo id>`;
      // empty while none is edited.
      edited: string
      // How many times the keyboard left the note editor, which draws its
      // cursor while this is the count it took the keyboard at.
      noteBlurs: number
      // The todo being dragged and how many todos away it is held, as
      // `<session id>:<todo id>:<steps>`; empty while none is dragged.
      dragged: string
      // Whether the pane is minimised: closed, with a row above the prompt
      // standing in for it.
      isCollapsed: boolean
      // Where the pane is seated: above the prompt (`isInline`) and put away
      // there while a long draft needs its rows (`isTucked`); and whether the
      // draft is long now (`isDraftLong`), which hides the row above the prompt.
      seating: { isInline: boolean; isTucked: boolean; isDraftLong: boolean }
    }
  }
}
