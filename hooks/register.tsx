import { atom, read, update } from 'claude-code'
import type { EngineInterface, PaneOpenArgs, Register } from 'claude-code'

import type { SessionNote, Todo } from '../types'
import { cellsOf } from './cells'
import { folderNameOf, toNote, toText } from './records'
import { readTitle } from './title'
import { add, adopt, moveBy, toTodos } from './todos'

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

// This session's title as last read, under its id. A session holding
// nothing keeps no record, yet its own card is drawn and is named by this.
let ownTitle: { sessionId: string; text: string } | undefined

// Marks this session as used now and brings its name up to date with the
// resume list's title. A record is kept only for a session that has todos or
// a note: one with neither leaves nothing behind.
const touch = async ($: EngineInterface): Promise<void> => {
  const sessionId = await $.session.id()
  const key = NOTE_PREFIX + sessionId
  const hasTodos =
    toTodos(await $.store.get(LIST_PREFIX + sessionId)).length > 0
  const hasText =
    typeof (await $.store.get(TEXT_PREFIX + sessionId)) === 'string'
  const title = await readTitle($)
  ownTitle = title === undefined ? undefined : { sessionId, text: title.text }
  if (!hasTodos && !hasText) {
    await $.store.delete(key)

    return
  }

  const kept = toNote(await $.store.get(key))
  const note: SessionNote = {
    folder: folderNameOf(await $.session.cwd()),
    usedAt: await $.clock.now(),
  }
  if (title?.isCustom === true) {
    note.name = title.text
    note.isNameCustom = true
  } else if (kept?.isNameCustom === true && kept.name !== undefined) {
    note.name = kept.name
    note.isNameCustom = true
  } else {
    const name = title?.text ?? kept?.name
    if (name !== undefined) note.name = name
  }
  if (note.name !== undefined) note.isNameFromTitle = true
  await $.store.set(key, note)
}

// Saves this session's note. The session's record is brought up to date when
// the note is its first or was its last, so that a session gets its title
// with its first note and leaves no record once it holds nothing. Other
// saves leave the record to the next prompt: the editor saves on every key.
const saveNote = async ($: EngineInterface, text: string): Promise<void> => {
  const key = TEXT_PREFIX + (await $.session.id())
  const hadText = typeof (await $.store.get(key)) === 'string'
  const hasText = text.trim() !== ''
  if (hasText) await $.store.set(key, text)
  else await $.store.delete(key)
  if (hadText !== hasText) {
    await touch($)
    await redraw($)
  }
}

// Brings the records an earlier version left to what is kept now: the
// folder's name in place of its path, and none for a session with nothing.
const tidyRecords = async ($: EngineInterface): Promise<void> => {
  for (const key of await $.store.keys()) {
    if (!key.startsWith(NOTE_PREFIX)) continue
    const sessionId = key.slice(NOTE_PREFIX.length)
    const note = toNote(await $.store.get(key))
    const hasTodos =
      toTodos(await $.store.get(LIST_PREFIX + sessionId)).length > 0
    const hasText =
      typeof (await $.store.get(TEXT_PREFIX + sessionId)) === 'string'
    if (note === undefined || (!hasTodos && !hasText)) {
      await $.store.delete(key)
    } else {
      await $.store.set(key, note)
    }
  }
}

const tab = atom({ plugin: 'cc-todo', key: 'tab' } as const, 'todo')
const edited = atom({ plugin: 'cc-todo', key: 'edited' } as const, '')

const dragged = atom({ plugin: 'cc-todo', key: 'dragged' } as const, '')
const isCollapsed = atom(
  { plugin: 'cc-todo', key: 'isCollapsed' } as const,
  false,
)

// What the pane's body loses to the card around a todo's text: the padding,
// the border, the circle, the margins and the two marks at the row's end.
const CELLS_AROUND_TEXT = 13

// What the field of the todo being edited holds, under the field's key, as
// it last changed: what is saved when the person leaves the field for
// something else in the pane.
let fieldDraft: { key: string; text: string } | undefined

const redraw = ($: EngineInterface) => update($, changes, n => n + 1)

// A change reads the whole list and writes it back, so two at once could
// each start from the same list and the later write drop the earlier one.
// They are run one after another: each waits for the one before it.
let lastChange: Promise<void> = Promise.resolve()

const applyChange = async (
  $: EngineInterface,
  fn: (list: Todo[]) => Todo[],
  sessionId?: string,
): Promise<void> => {
  const ownId = await $.session.id()
  const id = sessionId ?? ownId
  const key = LIST_PREFIX + id
  const changed = fn(toTodos(await $.store.get(key)))
  if (changed.length === 0) await $.store.delete(key)
  else await $.store.set(key, changed)
  if (id === ownId) {
    await touch($)
  } else if (
    changed.length === 0 &&
    typeof (await $.store.get(TEXT_PREFIX + id)) !== 'string'
  ) {
    // Another session's last todo, and it has no note: its record goes with
    // it. Its title and time are its own to refresh, so nothing else is done.
    await $.store.delete(NOTE_PREFIX + id)
  }
  await redraw($)
}

// Each session has its own list, under its id. The id is read each time: a
// /clear or a resume inside the process goes on under another id.
const change = (
  $: EngineInterface,
  fn: (list: Todo[]) => Todo[],
  sessionId?: string,
): Promise<void> => {
  const applied = lastChange.then(() => applyChange($, fn, sessionId))
  // A change that failed must not hold back the ones after it.
  lastChange = applied.catch(() => undefined)

  return applied
}

// Ends the edit of the todo marked as edited, with `value` as its text
// unless that is empty, which leaves the text as it was.
const saveEdited = async ($: EngineInterface, value: string): Promise<void> => {
  const [editedSession, editedId] = (await read($, edited)).split(':')
  if (editedSession === undefined || editedId === undefined) return
  // A todo is one line: a newline typed in a field of several rows is a space.
  const text = value.replace(/\s*\n\s*/g, ' ').trim()
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
  fieldDraft = undefined
  await update($, edited, () => '')
}

// Saves the field of the todo being edited as the person turns to `element`,
// another part of the pane; the field itself and its cancel are no leaving.
const leaveField = async (
  $: EngineInterface,
  element: string | undefined,
): Promise<void> => {
  const [editedSession, editedId] = (await read($, edited)).split(':')
  if (editedSession === undefined || editedId === undefined) return
  const key = `edit-${editedSession}-${editedId}`
  if (fieldDraft?.key !== key) return
  if (element === key || element === `cancel-${key}`) return
  await saveEdited($, fieldDraft.text)
}

// Todos written while the list was shared go to the first session that
// starts afterwards, after any it already has, so none is lost.
const adoptSharedList = async ($: EngineInterface): Promise<void> => {
  const shared = toTodos(await $.store.get(SHARED_KEY))
  if (shared.length === 0) return

  await change($, adopt(shared))
  await $.store.delete(SHARED_KEY)
}

type SessionTodos = {
  sessionId: string
  isOwn: boolean
  note: SessionNote | undefined
  list: Todo[]
  text: string
}

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

const folderOf = (session: SessionTodos): string => session.note?.folder ?? '?'

const nameOf = (session: SessionTodos): string =>
  session.note?.name ??
  (session.isOwn && ownTitle?.sessionId === session.sessionId
    ? ownTitle.text
    : 'Untitled session')

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
    await tidyRecords($)
    await touch($)
    await redraw($)
    // A reload runs this again: a pane the person closed, minimised or that
    // is put away for a draft stays as it is.
    const isAway = (await read($, isCollapsed)) || (await seatingOf($)).isTucked
    if (!isAway && (await $.store.get(CLOSED_KEY)) !== true) {
      void $.ui.open(SEAT)
    }

    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    // Minimised or put away for a draft, the pane is not one the person
    // closed for good.
    const isAway = (await read($, isCollapsed)) || (await seatingOf($)).isTucked
    if (e.id === PANE) drawnSeat = undefined
    if (e.id === PANE && e.origin.kind !== 'unload' && !isAway) {
      await seatAs($, DOCKED)
      await $.store.set(CLOSED_KEY, true)
    }

    return next(e)
  })

  // A draft that grows long takes the rows of a pane above the prompt, and
  // gives them back once it is short again.
  on('prompt.change', async ($, e, next) => {
    const isLong = isLongDraft(e.text)
    const seated = await seatingOf($)
    // Nothing to do but where the draft crosses from short to long or back.
    if (seated.isDraftLong !== isLong) {
      const isInline =
        drawnSeat === undefined ? seated.isInline : drawnSeat === 'inline'
      const isPutAway =
        isLong && isInline && !seated.isTucked && !(await read($, isCollapsed))
      await seatAs($, {
        isInline: seated.isInline || isPutAway,
        isDraftLong: isLong,
        isTucked: seated.isTucked || isPutAway,
      })
      if (isPutAway) await $.ui.close({ id: PANE })
    }

    return next(e)
  })

  // A /clear or a resume changes the session without a session.start: the
  // next prompt draws the list of the session it belongs to.
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
    // A post from anything but the field of the todo being edited, the free
    // room under the rows included, is the person having left that field.
    await leaveField($, e.element)
    if (
      e.element === `note-${sessionId}` &&
      typeof posted === 'object' &&
      posted !== null &&
      'text' in posted &&
      typeof posted.text === 'string'
    ) {
      await saveNote($, posted.text)
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

    return next(e)
  })

  // Leaving the field of the todo being edited for something else in the
  // pane saves what it holds, as Enter does: the ring moved by a click or
  // the keys, or a button pressed. Its own cancel is left to discard it.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await leaveField($, e.element)

    return next(e)
  })

  on('ui.press', { requestId: PANE }, async ($, e, next) => {
    await leaveField($, e.element)

    return next(e)
  })

  // The engine titles a session after its first prompt is sent, which is
  // after that prompt's own reading of the name: the turn's end reads it
  // again, so the session is named by then and not a prompt later.
  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    if (e.agentId === undefined) {
      await touch($)
      await redraw($)
    }

    return ended
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
      await $.ui.open({ ...SEAT, focus: true })

      return { text: `Notes tab opened.${whereDrawn}` }
    }

    if (text === 'all') {
      await update($, isAllShown, () => true)
      await $.ui.open({ ...SEAT, focus: true })

      return { text: `Showing all sessions.${whereDrawn}` }
    }

    if (text !== '') {
      await update($, tab, () => 'todo')
      await change($, add(text))
      await $.ui.open(SEAT)

      return { text: `Added: ${text}` }
    }

    await update($, isAllShown, () => false)
    await redraw($)
    await $.ui.open({ ...SEAT, focus: true })

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
    // The wrapping fields and the drag handle are surface modules, which take
    // the keyboard and the pointer by a click. The terminal reports clicks in
    // its fullscreen layout alone, so elsewhere the plain fields are drawn,
    // which the focus ring reaches from the keyboard.
    const hasPointer =
      e.surface === 'desktop' ||
      (e.surface === 'terminal' && e.viewport?.isFullscreen === true)
    const isDoneHidden = (await $.store.get(DONE_HIDDEN_KEY)) === true
    const textColumns = Math.max(8, e.props.bodyColumns - CELLS_AROUND_TEXT)
    const linesOf = (one: Todo): number =>
      Math.max(1, Math.ceil(cellsOf(one.text) / textColumns))
    const sessions = await readSessions($, isEverySession)
    const ownFolder = folderNameOf(await $.session.cwd())

    // The row of the todo being edited: its text in a plain field as tall as
    // the text's lines. A plain field takes the keyboard as it is drawn, which
    // a surface module does only by a click of its own.
    const field = (session: SessionTodos, one: Todo) => {
      const key = `edit-${session.sessionId}-${one.id}`
      if (fieldDraft?.key !== key) fieldDraft = { key, text: one.text }

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
            <Input
              key={key}
              value={one.text}
              submitLabel=""
              rows={linesOf(one)}
              autoFocus
              onInput={value => {
                fieldDraft = { key, text: value }
              }}
              onSubmit={value => saveEdited($, value)}
            />
            <Box flexDirection="row" justifyContent="flex-end">
              <Button
                key={`cancel-${key}`}
                label="cancel"
                plain
                dimColor
                onPress={() => update($, edited, () => '')}
              />
            </Box>
          </Box>
        </Box>
      )
    }

    // The handle a todo is dragged by, where the surface draws one. It is
    // told how many lines the todos around it take, to read the pointer's row.
    const dragHandle = (
      session: SessionTodos,
      group: Todo[],
      index: number,
    ) => {
      if (!hasPointer) return null
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
            later lines start under its first, past the circle. Pressing it
            turns the row into the field that edits it. */}
            <Box flexGrow={1} flexShrink={1} marginLeft={1} marginRight={1}>
              <Button
                key={`edit-button-${session.sessionId}-${one.id}`}
                plain
                onPress={async () => {
                  await update(
                    $,
                    edited,
                    () => `${session.sessionId}:${one.id}`,
                  )
                  // The press gave the pane the keys: the field takes them now,
                  // with no click of its own.
                  await $.ui.focus({
                    requestId: PANE,
                    key: `edit-${session.sessionId}-${one.id}`,
                  })
                }}
              >
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
              </Button>
            </Box>
            <Box flexDirection="row" gap={1} flexShrink={0}>
              {dragHandle(session, group, index)}
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
                label={
                  isDoneHidden ? `Show done (${done.length})` : 'Hide done'
                }
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
      if (hasPointer && (e.surface === 'terminal' || e.surface === 'desktop')) {
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

      return (
        <Box flexDirection="column">
          {session.text !== '' && <Markdown text={session.text} />}
          <Input
            key="note-field"
            rows={6}
            placeholder="Write something…"
            submitLabel=""
            value={session.text}
            onSubmit={value => {
              void (async () => {
                await saveNote($, value)
                await redraw($)
              })()
            }}
          />
        </Box>
      )
    }

    // Where a new todo is typed: a plain field, which shows its cursor only
    // while it has the keyboard, as a surface module cannot tell.
    const newTodoField = () => {
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
        <Button
          key={`tab-${id}`}
          plain
          onPress={() => update($, tab, () => id)}
        >
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

    // While a todo is edited in a docked pane, the room under the rows takes
    // a click as leaving the field: the body is stretched to the pane's rows
    // and what is left of them listens.
    const clickAway = (() => {
      if (editedKey === '' || isNoteTab || !hasPointer) return null
      if (e.props.placement !== 'dock') return null
      if (e.surface !== 'terminal' && e.surface !== 'desktop') return null
      const { Client } = $.ui.resolve(e)

      return (
        <Client
          key="click-away"
          module="./click-away.tsx"
          width="100%"
          flexGrow={1}
        />
      )
    })()

    return (
      <Box
        flexDirection="column"
        paddingX={1}
        {...(clickAway === null ? {} : { minHeight: e.props.scroll.bodyRows })}
      >
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
        {clickAway}
      </Box>
    )
  })
}
