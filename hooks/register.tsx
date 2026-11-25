import { atom, read, update } from 'claude-code'
import type { EngineInterface, PaneOpenArgs, Register } from 'claude-code'

import type { SessionNote, Todo } from '../types'

const PANE = 'cc-todo'
const TITLE = 'Todo'
// The one list every session shared before lists were kept per session.
const SHARED_KEY = 'items'
const LIST_PREFIX = 'items:'
const NOTE_PREFIX = 'note:'
// A session's markdown note, as the person typed it.
const TEXT_PREFIX = 'text:'
// The fullscreen layout docks a pane beside the transcript from this width.
const DOCK_MIN_COLUMNS = 110
// The rows the pane asks for while it sits above the prompt.
const INLINE_ROWS = 8
// A draft past this many cells or lines needs the rows an inline pane holds.
const LONG_DRAFT_CELLS = 140
const LONG_DRAFT_LINES = 3
// Set once the pane is closed, so a later start or reload leaves it closed
// until the person asks for it again.
const CLOSED_KEY = 'isPaneClosed'
// Set while done todos are left out of the lists; kept for every session.
const DONE_HIDDEN_KEY = 'isDoneHidden'

const changes = atom({ plugin: 'cc-todo', key: 'changes' } as const, 0)
const isAllShown = atom(
  { plugin: 'cc-todo', key: 'isAllShown' } as const,
  false,
)

// The store outlives the code that wrote it, so what it holds is checked
// before it is trusted.
const toTodos = (stored: unknown): Todo[] => {
  if (!Array.isArray(stored)) return []

  const todos: Todo[] = []
  for (const one of stored) {
    if (
      typeof one === 'object' &&
      one !== null &&
      typeof one.id === 'number' &&
      typeof one.text === 'string' &&
      typeof one.isDone === 'boolean'
    ) {
      todos.push({ id: one.id, text: one.text, isDone: one.isDone })
    }
  }

  return todos
}

const toNote = (stored: unknown): SessionNote | undefined => {
  if (typeof stored !== 'object' || stored === null) return undefined
  if (!('cwd' in stored) || typeof stored.cwd !== 'string') return undefined
  // `changedAt` is what a note written before `usedAt` carries.
  const usedAt =
    'usedAt' in stored
      ? stored.usedAt
      : 'changedAt' in stored
        ? stored.changedAt
        : undefined
  if (typeof usedAt !== 'number') return undefined
  const name =
    'name' in stored && typeof stored.name === 'string' ? stored.name : undefined
  const isNameCustom = 'isNameCustom' in stored && stored.isNameCustom === true
  const note: SessionNote = { cwd: stored.cwd, usedAt }
  if (name !== undefined) note.name = name
  if (isNameCustom) note.isNameCustom = true

  return note
}

const NAME_MAX_LENGTH = 40
// How much of the transcript's end is searched for a title: the engine writes
// the title again as the session goes on, so the newest is near the end.
const TITLE_TAIL_BYTES = 262144

type Title = { text: string; isCustom: boolean }

// The title the resume list shows, read from the end of the session's
// transcript: the one given with /rename, else the generated one. The
// transcript's rows are the engine's own format, so a row that does not read
// as expected is passed over and no title is an answer.
const readTitle = async ($: EngineInterface): Promise<Title | undefined> => {
  try {
    const { transcriptPath } = await $.session.info()
    if (transcriptPath === '') return undefined
    const { size } = await $.fs.stat(transcriptPath)
    const offset = Math.max(0, size - TITLE_TAIL_BYTES)
    const tail = await $.fs.read(transcriptPath, {
      offset,
      length: size - offset,
    })

    let custom: string | undefined
    let generated: string | undefined
    for (const line of tail.split('\n')) {
      if (!line.includes('-title"')) continue
      try {
        const row: unknown = JSON.parse(line)
        if (typeof row !== 'object' || row === null) continue
        if ('customTitle' in row && typeof row.customTitle === 'string') {
          custom = row.customTitle
        }
        if ('aiTitle' in row && typeof row.aiTitle === 'string') {
          generated = row.aiTitle
        }
      } catch {
        // The first line of the tail is cut where the range starts.
      }
    }
    if (custom !== undefined && custom !== '') {
      return { text: custom, isCustom: true }
    }
    if (generated !== undefined && generated !== '') {
      return { text: generated, isCustom: false }
    }

    return undefined
  } catch {
    return undefined
  }
}

// Marks this session as used now and brings its name up to date: the resume
// list's title where the transcript has one, else the first prompt seen.
const touch = async ($: EngineInterface, prompt?: string): Promise<void> => {
  const key = NOTE_PREFIX + (await $.session.id())
  const kept = toNote(await $.store.get(key))
  const title = await readTitle($)
  const firstLine = prompt?.trim().split('\n')[0] ?? ''
  const fromPrompt =
    firstLine !== '' && !firstLine.startsWith('/')
      ? firstLine.slice(0, NAME_MAX_LENGTH)
      : undefined

  const note: SessionNote = {
    cwd: await $.session.cwd(),
    usedAt: await $.clock.now(),
  }
  if (title?.isCustom === true) {
    note.name = title.text
    note.isNameCustom = true
  } else if (kept?.isNameCustom === true && kept.name !== undefined) {
    note.name = kept.name
    note.isNameCustom = true
  } else {
    const name = title?.text ?? kept?.name ?? fromPrompt
    if (name !== undefined) note.name = name
  }
  await $.store.set(key, note)
}

const tab = atom({ plugin: 'cc-todo', key: 'tab' } as const, 'todo')
const edited = atom({ plugin: 'cc-todo', key: 'edited' } as const, '')

const dragged = atom({ plugin: 'cc-todo', key: 'dragged' } as const, '')
const isCollapsed = atom(
  { plugin: 'cc-todo', key: 'isCollapsed' } as const,
  false,
)

// Moves the todo `id` by `steps` places among the todos that are done as it
// is (the pane lists the open ones, then the done ones).
const moveBy =
  (id: number, steps: number) =>
  (list: Todo[]): Todo[] => {
    const moved = list.find(one => one.id === id)
    if (moved === undefined) return list
    const group = list.filter(one => one.isDone === moved.isDone)
    const from = group.indexOf(moved)
    const to = Math.max(0, Math.min(group.length - 1, from + steps))
    const target = group[to]
    if (target === undefined || to === from) return list
    const rest = list.filter(one => one.id !== id)
    const at = rest.indexOf(target) + (to > from ? 1 : 0)

    return [...rest.slice(0, at), moved, ...rest.slice(at)]
  }

// The cells a text takes: two for an East Asian wide character.
const cellsOf = (text: string): number =>
  Array.from(text).reduce((sum, character) => {
    const codePoint = character.codePointAt(0) ?? 0
    const isWide =
      (codePoint >= 0x1100 && codePoint <= 0x115f) ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60)

    return sum + (isWide ? 2 : 1)
  }, 0)

// What the pane's body loses to the card around a todo's text: the padding,
// the border, the circle, the margins and the three marks at the row's end.
const CELLS_AROUND_TEXT = 15

const redraw = ($: EngineInterface) => update($, changes, n => n + 1)

// Each session has its own list, under its id. The id is read each time: a
// /clear or a resume inside the process goes on under another id.
const change = async (
  $: EngineInterface,
  fn: (list: Todo[]) => Todo[],
  sessionId?: string,
): Promise<void> => {
  const ownId = await $.session.id()
  const id = sessionId ?? ownId
  const key = LIST_PREFIX + id
  await $.store.set(key, fn(toTodos(await $.store.get(key))))
  if (id === ownId) await touch($)
  await redraw($)
}

const add = (text: string) => (list: Todo[]) => {
  const nextId = list.reduce((max, one) => Math.max(max, one.id), 0) + 1

  return [...list, { id: nextId, text, isDone: false }]
}

// Todos written while the list was shared go to the first session that
// starts afterwards, so none is lost.
const adoptSharedList = async ($: EngineInterface): Promise<void> => {
  const shared = toTodos(await $.store.get(SHARED_KEY))
  if (shared.length === 0) return

  await change($, own => (own.length === 0 ? shared : own))
  await $.store.delete(SHARED_KEY)
}

type SessionTodos = {
  sessionId: string
  isOwn: boolean
  note: SessionNote | undefined
  list: Todo[]
  text: string
}

const toText = (stored: unknown): string =>
  typeof stored === 'string' ? stored : ''

// This session first, then the others by their latest change; a session
// with no todo left is not listed.
const readSessions = async (
  $: EngineInterface,
  isEverySession: boolean,
): Promise<SessionTodos[]> => {
  const ownId = await $.session.id()
  const ids = isEverySession
    ? (await $.store.keys())
        .filter(
          key => key.startsWith(LIST_PREFIX) || key.startsWith(TEXT_PREFIX),
        )
        .map(key => key.slice(key.indexOf(':') + 1))
        .filter((id, index, all) => all.indexOf(id) === index)
    : []
  if (!ids.includes(ownId)) ids.push(ownId)

  const sessions: SessionTodos[] = []
  for (const sessionId of ids) {
    const list = toTodos(await $.store.get(LIST_PREFIX + sessionId))
    const isOwn = sessionId === ownId
    const text = toText(await $.store.get(TEXT_PREFIX + sessionId))
    if (list.length === 0 && text === '' && !isOwn) continue
    const note = toNote(await $.store.get(NOTE_PREFIX + sessionId))
    sessions.push({ sessionId, isOwn, note, list, text })
  }

  return sessions.sort((a, b) => {
    if (a.isOwn !== b.isOwn) return a.isOwn ? -1 : 1

    return (b.note?.usedAt ?? 0) - (a.note?.usedAt ?? 0)
  })
}

const twoDigits = (n: number): string => String(n).padStart(2, '0')

const folderOf = (session: SessionTodos): string =>
  session.note?.cwd.split('/').filter(Boolean).pop() ?? '?'

const nameOf = (session: SessionTodos): string =>
  session.note?.name ?? 'Untitled session'

// When the session was last used, led by its folder where that is not the
// folder this session runs in.
const detailOf = (session: SessionTodos, ownFolder: string): string => {
  const folder = folderOf(session)
  const parts = session.isOwn || folder === ownFolder ? [] : [`${folder}/`]
  if (session.note !== undefined) {
    const at = new Date(session.note.usedAt)
    const day = `${twoDigits(at.getMonth() + 1)}/${twoDigits(at.getDate())}`
    const time = `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`
    parts.push(`${day} ${time}`)
  }

  return parts.join(' · ')
}

// The pane's own colors, raw so that they hold on any theme: a navy card,
// a periwinkle border, cyan for names and coral for the mark.
const CARD = '#1f2437'
const BORDER = '#7a7fd0'
const BORDER_OTHER = '#454a6b'
const NAME = '#5ec4e8'
const MARK = '#e8825a'
const DONE = '#7fd88f'
const BAR_CELLS = 10

// The pane leaves the screen in two ways, and a row above the prompt stands
// in for it both times, bringing it back at a press.
//
// Minimised by the person (`isCollapsed`), it is closed: docked, that gives
// the whole column back, which no narrower pane could.
//
// Above the prompt, a long draft has no room left under it, however few rows
// the pane keeps: the pane is closed as the draft grows (`isTucked`). A prompt
// sent brings it back. A draft cut short or cancelled cannot: on a narrow
// terminal the surface seats a pane only behind the person's own command,
// prompt or press, hence the row.
//
// The row itself is hidden while the draft is long. Where the pane is seated
// is kept in the session's state, which a reload of this module does not
// lose; `seating` is this module's copy of it, so a key typed costs no read.
type Seating = { isInline: boolean; isTucked: boolean; isDraftLong: boolean }

const DOCKED: Seating = { isInline: false, isTucked: false, isDraftLong: false }
const INLINE: Seating = { isInline: true, isTucked: false, isDraftLong: false }

const seatingState = atom(
  { plugin: 'cc-todo', key: 'seating' } as const,
  DOCKED,
)
let seating: Seating | undefined
// Where the surface seated the pane, as its last drawing was told: known for
// a pane this module did not open behind a command, and after the seat
// changes. Absent until the pane is drawn, and once it is closed.
let drawnSeat: 'dock' | 'inline' | 'widget' | undefined

const seatingOf = async ($: EngineInterface): Promise<Seating> => {
  seating ??= await read($, seatingState)

  return seating
}

const seatAs = async ($: EngineInterface, next: Seating): Promise<void> => {
  seating = next
  await update($, seatingState, () => next)
}

// How the pane is opened: its width where it docks, its rows where it sits
// above the prompt; each seat reads its own and ignores the other.
const SEAT: PaneOpenArgs = {
  id: PANE,
  title: TITLE,
  columns: 36,
  backgroundColor: 'transparent',
  rows: INLINE_ROWS,
}

// Brings the pane back from either way it left. Called behind the person's
// command, prompt or press, which is what seats it at any width.
const bringBack = async (
  $: EngineInterface,
  isInline: boolean,
): Promise<void> => {
  // Where the surface does not seat it, it stays away and the row that
  // offers it stays up.
  const opened = await $.ui.open(SEAT)
  if (!opened.isPlaced) return
  const { isDraftLong } = await seatingOf($)
  await update($, isCollapsed, () => false)
  await seatAs($, { isInline, isTucked: false, isDraftLong })
}

const isLongDraft = (text: string): boolean =>
  text.split('\n').length >= LONG_DRAFT_LINES ||
  cellsOf(text) > LONG_DRAFT_CELLS

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'todo',
      description:
        'Todos and notes for this session. /todo <text> adds one; /todo note, /todo all, /todo close',
      argumentHint: '[text | note | all | close]',
    })
    await adoptSharedList($)
    await touch($)
    await redraw($)
    // A reload runs this again: a pane the person closed, minimised or that
    // is put away for a draft stays as it is.
    const isAway =
      (await read($, isCollapsed)) || (await seatingOf($)).isTucked
    if (!isAway && (await $.store.get(CLOSED_KEY)) !== true) {
      void $.ui.open(SEAT)
    }

    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    // Put away for a draft, the pane is not one the person closed.
    // Minimised or put away for a draft, the pane is not one the person
    // closed for good.
    const isAway =
      (await read($, isCollapsed)) || (await seatingOf($)).isTucked
    if (e.id === PANE) drawnSeat = undefined
    if (e.id === PANE && e.origin.kind !== 'unload' && !isAway) {
      await seatAs($, DOCKED)
      await $.store.set(CLOSED_KEY, true)
    }

    return next(e)
  })

  // A /clear or a resume changes the session without a session.start: the
  // next prompt draws the list of the session it belongs to.
  on('prompt.change', async ($, e, next) => {
    const isLong = isLongDraft(e.text)
    const seated = await seatingOf($)
    // Nothing to do but where the draft crosses from short to long or back.
    if (seated.isDraftLong !== isLong) {
      const isInline =
        drawnSeat === undefined ? seated.isInline : drawnSeat === 'inline'
      const isPutAway =
        isLong &&
        isInline &&
        !seated.isTucked &&
        !(await read($, isCollapsed))
      await seatAs($, {
        isInline: seated.isInline || isPutAway,
        isDraftLong: isLong,
        isTucked: seated.isTucked || isPutAway,
      })
      if (isPutAway) await $.ui.close({ id: PANE })
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // The prompt is sent: the draft is gone, and a pane put away for it
    // comes back. One the person minimised stays minimised.
    const seated = await seatingOf($)
    if (seated.isTucked) {
      await seatAs($, { ...seated, isDraftLong: false })
      void bringBack($, true)
    }
    await touch($)
    await redraw($)

    return next(e)
  })

  // The note editor posts its text on every edit; it is this session's note.
  // The editor draws from its own copy, so nothing is drawn again here.
  on('ui.message', async ($, e, next) => {
    const sessionId = await $.session.id()
    const posted = e.data
    if (
      e.element === `note-${sessionId}` &&
      typeof posted === 'object' &&
      posted !== null &&
      'text' in posted &&
      typeof posted.text === 'string'
    ) {
      const key = TEXT_PREFIX + sessionId
      if (posted.text.trim() === '') await $.store.delete(key)
      else await $.store.set(key, posted.text)
    }

    // A drag handle posts how far its todo is held from its place, and once
    // more when it is dropped there.
    const handle = /^drag-(.+)-(\d+)$/.exec(e.element)
    if (
      handle !== null &&
      typeof posted === 'object' &&
      posted !== null &&
      'steps' in posted &&
      typeof posted.steps === 'number' &&
      Number.isInteger(posted.steps)
    ) {
      const [, handleSession = '', handleId = ''] = handle
      const steps = posted.steps
      if ('isDropped' in posted && posted.isDropped === true) {
        await update($, dragged, () => '')
        if (steps !== 0) {
          await change($, moveBy(Number(handleId), steps), handleSession)
        }
      } else {
        await update($, dragged, () => `${handleSession}:${handleId}:${steps}`)
      }
    }

    // The field new todos are typed in posts its text on Enter.
    if (
      e.element === 'new-todo' &&
      typeof posted === 'object' &&
      posted !== null &&
      'submit' in posted &&
      typeof posted.submit === 'string' &&
      posted.submit.trim() !== ''
    ) {
      await change($, add(posted.submit.trim()))
    }

    // The field of the todo being edited posts its text on Enter. Which todo
    // is the one marked as edited, never what the post names.
    const editedKey = await read($, edited)
    const [editedSession, editedId] = editedKey.split(':')
    if (
      editedSession !== undefined &&
      editedId !== undefined &&
      e.element === `edit-${editedSession}-${editedId}` &&
      typeof posted === 'object' &&
      posted !== null &&
      'submit' in posted &&
      typeof posted.submit === 'string'
    ) {
      const text = posted.submit.trim()
      if (text !== '') {
        await change(
          $,
          all =>
            all.map(each =>
              String(each.id) === editedId ? { ...each, text } : each,
            ),
          editedSession,
        )
      }
      await update($, edited, () => '')
    }

    return next(e)
  })

  // A /rename is no prompt, so the name is read again once it has run.
  on('command.run', { command: 'rename' }, async ($, e, next) => {
    const ran = await next(e)
    await touch($)
    await redraw($)

    return ran
  })

  on('command.run', { command: 'todo' }, async ($, e) => {
    await touch($)
    const text = e.args.trim()
    const { isFullscreen, columns } = e.presentation
    // Above the prompt the pane shares the screen's height with the prompt
    // box, so it asks for a few rows and scrolls, leaving room to type.
    const isDocked = isFullscreen && columns >= DOCK_MIN_COLUMNS
    const seat = SEAT
    await seatAs($, !isDocked && text !== 'close' ? INLINE : DOCKED)
    // Asking for the pane brings it back from minimised.
    await update($, isCollapsed, () => false)
    const whereDrawn = !isFullscreen
      ? ' Not in fullscreen layout, so the pane sits above the prompt. It docks on the right in fullscreen at 110+ columns.'
      : columns < DOCK_MIN_COLUMNS
        ? ` Terminal is ${columns} columns wide; the pane docks on the right from ${DOCK_MIN_COLUMNS}.`
        : ''

    if (text === 'close') {
      // Kept here, not left to the close event: a pane already away, minimised
      // or put away for a draft, has nothing left to close and raises none.
      await $.store.set(CLOSED_KEY, true)
      await $.ui.close({ id: PANE })

      return { text: 'Todo pane closed. /todo opens it again.' }
    }

    await $.store.delete(CLOSED_KEY)

    if (text === 'note') {
      await update($, tab, () => 'note')
      await $.ui.open({ ...seat, focus: true })

      return { text: `Notes tab opened.${whereDrawn}` }
    }

    if (text === 'all') {
      await update($, isAllShown, () => true)
      await $.ui.open({ ...seat, focus: true })

      return { text: `Showing all sessions.${whereDrawn}` }
    }

    if (text !== '') {
      await update($, tab, () => 'todo')
      await change($, add(text))
      await $.ui.open(seat)

      return { text: `Added: ${text}` }
    }

    await update($, isAllShown, () => false)
    await redraw($)
    await $.ui.open({ ...seat, focus: true })

    return { text: `Todo pane opened.${whereDrawn}` }
  })

  // The row that stands in for the pane while it is minimised or put away.
  // A press on it is the person's own, which seats the pane at any width.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const seated = await read($, seatingState)
    const isMinimised = await read($, isCollapsed)
    if (seated.isDraftLong || (!isMinimised && !seated.isTucked)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    await read($, changes)
    const openCount = toTodos(
      await $.store.get(LIST_PREFIX + (await $.session.id())),
    ).filter(one => !one.isDone).length
    // Where it will be seated: docked from the width the layout docks at.
    const isInline = !(
      e.viewport?.isFullscreen === true &&
      e.viewport.columns >= DOCK_MIN_COLUMNS
    )

    return (
      <Box>
        <Button key="bring-back" plain onPress={() => bringBack($, isInline)}>
          <Text dimColor>▸ </Text>
          <Text bold color={MARK}>
            Todo
          </Text>
          <Text dimColor> {openCount} open</Text>
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Markdown } = $.ui.resolve(e)
    drawnSeat = e.props.placement
    await read($, changes)
    const isEverySession = await read($, isAllShown)
    const isNoteTab = (await read($, tab)) === 'note'
    const editedKey = await read($, edited)
    const draggedKey = await read($, dragged)
    const isDoneHidden = (await $.store.get(DONE_HIDDEN_KEY)) === true
    const textColumns = Math.max(8, e.props.bodyColumns - CELLS_AROUND_TEXT)
    const linesOf = (one: Todo): number =>
      Math.max(1, Math.ceil(cellsOf(one.text) / textColumns))
    const sessions = await readSessions($, isEverySession)
    const ownFolder =
      (await $.session.cwd()).split('/').filter(Boolean).pop() ?? ''

    // The row of the todo being edited: its text in a field that wraps, where
    // the surface draws one (the editor's surface module), else the plain field.
    const field = (session: SessionTodos, one: Todo) => {
      const key = `edit-${session.sessionId}-${one.id}`
      const save = async (value: string): Promise<void> => {
        const text = value.trim()
        if (text !== '') {
          await change(
            $,
            all =>
              all.map(each => (each.id === one.id ? { ...each, text } : each)),
            session.sessionId,
          )
        }
        await update($, edited, () => '')
      }
      const cancel = (
        <Button
          key={`cancel-edit-${session.sessionId}-${one.id}`}
          label="cancel"
          plain
          dimColor
          onPress={() => update($, edited, () => '')}
        />
      )

      if (e.surface === 'terminal' || e.surface === 'desktop') {
        const { Client } = $.ui.resolve(e)

        return (
          <Box flexDirection="row">
            <Text color={one.isDone ? DONE : BORDER}>
              {one.isDone ? '●' : '○'}
            </Text>
            <Box
              flexDirection="column"
              flexGrow={1}
              flexShrink={1}
              marginLeft={1}
            >
              <Client
                key={key}
                module="./note-editor.tsx"
                props={{ text: one.text, isOneLine: true }}
                width="100%"
              />
              <Box flexDirection="row" justifyContent="flex-end">
                {cancel}
              </Box>
            </Box>
          </Box>
        )
      }

      return (
        <Box flexDirection="row" gap={1}>
          <Box flexGrow={1}>
            <Input
              key={key}
              value={one.text}
              submitLabel=""
              autoFocus
              onSubmit={value => {
                void save(value)
              }}
            />
          </Box>
          {cancel}
        </Box>
      )
    }

    // The handle a todo is dragged by, where the surface draws one. It is
    // told how many lines the todos around it take, to read the pointer's row.
    const dragHandle = (session: SessionTodos, group: Todo[], index: number) => {
      if (e.surface !== 'terminal' && e.surface !== 'desktop') return null
      const { Client } = $.ui.resolve(e)
      const one = group[index]
      if (one === undefined) return null

      return (
        <Client
          key={`drag-${session.sessionId}-${one.id}`}
          module="./drag-handle.tsx"
          props={{
            own: linesOf(one),
            before: group.slice(0, index).reverse().map(linesOf),
            after: group.slice(index + 1).map(linesOf),
          }}
          width={1}
          height={1}
        />
      )
    }

    // Where the todo being dragged would land in `group`, and from where.
    const dropIn = (session: SessionTodos, group: Todo[]) => {
      const [dragSession, dragId, dragSteps] = draggedKey.split(':')
      if (dragSession !== session.sessionId) return undefined
      const from = group.findIndex(one => String(one.id) === dragId)
      if (from === -1) return undefined
      const to = Math.max(
        0,
        Math.min(group.length - 1, from + Number(dragSteps ?? 0)),
      )

      return { from, to }
    }

    const row =
      (session: SessionTodos, group: Todo[]) => (one: Todo, index: number) => {
        const drop = dropIn(session, group)
        const isDragged = drop !== undefined && drop.from === index
        const isTarget =
          drop !== undefined && drop.to === index && drop.to !== drop.from

        return editedKey === `${session.sessionId}:${one.id}` ? (
        field(session, one)
      ) : (
      <Box flexDirection="row">
        <Button
          key={`toggle-${session.sessionId}-${one.id}`}
          plain
          onPress={() =>
            change(
              $,
              all =>
                all.map(each =>
                  each.id === one.id
                    ? { ...each, isDone: !each.isDone }
                    : each,
                ),
              session.sessionId,
            )
          }
        >
          {isTarget ? (
            <Text color={MARK}>
              {drop !== undefined && drop.to > drop.from ? '▼' : '▲'}
            </Text>
          ) : one.isDone ? (
            <Text color={DONE}>●</Text>
          ) : (
            <Text color={BORDER}>○</Text>
          )}
        </Button>
        {/* The text has the row's free width and wraps within it, so its
            later lines start under its first, past the circle. */}
        <Box flexGrow={1} flexShrink={1} marginLeft={1} marginRight={1}>
          {one.isDone ? (
            <Text dimColor strikethrough wrap="wrap">
              {one.text}
            </Text>
          ) : (
            <Text
              wrap="wrap"
              dimColor={isDragged}
              {...(isTarget ? { color: MARK } : {})}
            >
              {one.text}
            </Text>
          )}
        </Box>
        <Box flexDirection="row" gap={1} flexShrink={0}>
        {dragHandle(session, group, index)}
        <Button
          key={`edit-button-${session.sessionId}-${one.id}`}
          label="✎"
          plain
          dimColor
          onPress={() =>
            update($, edited, () => `${session.sessionId}:${one.id}`)
          }
        />
        <Button
          key={`remove-${session.sessionId}-${one.id}`}
          label="×"
          plain
          dimColor
          onPress={() =>
            change(
              $,
              all => all.filter(each => each.id !== one.id),
              session.sessionId,
            )
          }
        />
        </Box>
      </Box>
      )
      }

    const card = (session: SessionTodos) => {
      const open = session.list.filter(one => !one.isDone)
      const done = session.list.filter(one => one.isDone)
      const total = session.list.length
      const filled =
        total === 0 ? 0 : Math.round((done.length / total) * BAR_CELLS)
      const detail = detailOf(session, ownFolder)

      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={session.isOwn ? BORDER : BORDER_OTHER}
          backgroundColor={CARD}
          paddingX={1}
          marginTop={1}
        >
          <Text bold color={session.isOwn ? NAME : 'text'} wrap="truncate-end">
            {nameOf(session)}
          </Text>
          {detail !== '' && <Text dimColor>{detail}</Text>}
          {total > 0 && (
            <Box flexDirection="row">
              <Text color={DONE}>{'━'.repeat(filled)}</Text>
              <Text dimColor>{'━'.repeat(BAR_CELLS - filled)}</Text>
              <Text dimColor>
                {' '}
                {done.length}/{total}
              </Text>
            </Box>
          )}
          {total === 0 && <Text dimColor>Nothing to do yet</Text>}
          {open.map(row(session, open))}
          {!isDoneHidden && done.map(row(session, done))}
          {done.length > 0 && (
            <Box flexDirection="row" justifyContent="space-between">
              <Button
                key={`hide-done-${session.sessionId}`}
                label={isDoneHidden ? `Show done (${done.length})` : 'Hide done'}
                plain
                dimColor
                onPress={async () => {
                  if (isDoneHidden) await $.store.delete(DONE_HIDDEN_KEY)
                  else await $.store.set(DONE_HIDDEN_KEY, true)
                  await redraw($)
                }}
              />
              <Button
                key={`clear-done-${session.sessionId}`}
                label="Clear done"
                plain
                dimColor
                onPress={() =>
                  change(
                    $,
                    all => all.filter(each => !each.isDone),
                    session.sessionId,
                  )
                }
              />
            </Box>
          )}
        </Box>
      )
    }

    // The editor is a surface module, which the terminal and the desktop app
    // draw; elsewhere the note is shown as it reads.
    const editor = (session: SessionTodos) => {
      if (e.surface === 'terminal' || e.surface === 'desktop') {
        const { Client } = $.ui.resolve(e)

        return (
          <Client
            key={`note-${session.sessionId}`}
            module="./note-editor.tsx"
            props={{ text: session.text }}
            width="100%"
          />
        )
      }

      return session.text === '' ? (
        <Text dimColor>No notes yet</Text>
      ) : (
        <Markdown text={session.text} />
      )
    }

    // Where a new todo is typed: a field that wraps, where the surface draws
    // one (the editor's surface module), else the plain field.
    const newTodoField = () => {
      if (e.surface === 'terminal' || e.surface === 'desktop') {
        const { Client } = $.ui.resolve(e)

        return (
          <Box flexDirection="row" flexGrow={1}>
            <Text>＋ </Text>
            <Box flexGrow={1} flexShrink={1}>
              <Client
                key="new-todo"
                module="./note-editor.tsx"
                props={{
                  text: '',
                  isOneLine: true,
                  isEmptiedOnSubmit: true,
                  placeholder: 'Add a todo…',
                }}
                width="100%"
              />
            </Box>
          </Box>
        )
      }

      return (
        <Input
          key="new-todo"
          label="＋"
          placeholder="Add a todo…"
          submitLabel=""
          value=""
          {...(editedKey === '' ? { autoFocus: true as const } : {})}
          onSubmit={value => {
            const text = value.trim()
            if (text !== '') void change($, add(text))
          }}
        />
      )
    }

    const noteCard = (session: SessionTodos) => {
      const detail = detailOf(session, ownFolder)

      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={session.isOwn ? BORDER : BORDER_OTHER}
          backgroundColor={CARD}
          paddingX={1}
          marginTop={1}
        >
          <Text bold color={session.isOwn ? NAME : 'text'} wrap="truncate-end">
            {nameOf(session)}
          </Text>
          {detail !== '' && <Text dimColor>{detail}</Text>}
          {session.isOwn ? editor(session) : <Markdown text={session.text} />}
        </Box>
      )
    }

    const tabButton = (id: 'todo' | 'note', label: string) => {
      const isShown = (id === 'note') === isNoteTab

      return (
        <Button key={`tab-${id}`} plain onPress={() => update($, tab, () => id)}>
          {isShown ? (
            <Text bold underline color={MARK}>
              {label}
            </Text>
          ) : (
            <Text dimColor>{label}</Text>
          )}
        </Button>
      )
    }

    // Minimising closes the pane; the row above the prompt then stands in.
    const fold = async (): Promise<void> => {
      await update($, isCollapsed, () => true)
      await $.ui.close({ id: PANE })
    }

    const shown = sessions.filter(
      session =>
        session.isOwn ||
        (isNoteTab ? session.text !== '' : session.list.length > 0),
    )

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          {/* The fold mark leads the heading as a disclosure triangle, the
              same place it takes when the pane is folded. */}
          <Box flexDirection="row" gap={2}>
            <Box flexDirection="row" gap={1}>
              <Button
                key="fold"
                label="▾"
                plain
                dimColor
                onPress={() => fold()}
              />
              {tabButton('todo', 'Todo')}
            </Box>
            {tabButton('note', 'Notes')}
          </Box>
          {isEverySession && <Text dimColor>all sessions</Text>}
        </Box>
        {!isNoteTab && (
          <Box
            flexDirection="row"
            borderStyle="round"
            borderColor={BORDER}
            paddingX={1}
          >
            {newTodoField()}
          </Box>
        )}
        {shown.map(isNoteTab ? noteCard : card)}
        <Box flexDirection="row" justifyContent="flex-end" marginTop={1}>
          <Button
            key="toggle-scope"
            plain
            onPress={() => update($, isAllShown, shown => !shown)}
          >
            <Text color={NAME}>
              {isEverySession ? 'This session' : 'All sessions'}
            </Text>
          </Button>
        </Box>
      </Box>
    )
  })
}
