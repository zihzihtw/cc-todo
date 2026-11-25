export type Todo = { id: number; text: string; isDone: boolean }

/** What is kept about a session beside its list, to name it among the others. */
export type SessionNote = {
  cwd: string
  // When the session was last used: started, prompted, or its list changed.
  usedAt: number
  // The title the resume list shows for the session; until its transcript
  // has one, the first prompt seen in it, cut short.
  name?: string
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
      // The todo being dragged and how many todos away it is held, as
      // `<session id>:<todo id>:<steps>`; empty while none is dragged.
      dragged: string
    }
  }
}
