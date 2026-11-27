import type { ClientKeyEvent, ClientModule } from 'claude-code'

import { cellsOf } from './cells'

// A small markdown editor in one block: the line the cursor is on is drawn as
// its source, wrapped to the pane's width, and every other line as the
// markdown it reads as, so a line is seen rendered once the cursor leaves it.
// Every edit is posted to the hooks module, which stores it.

type Props = { text: string }
// `cursor` counts characters (code points) from the start of `text`.
type State = { text: string; cursor: number }
// One row as drawn: the characters from `start` up to `end`, a line of the
// text or the part of one that fits the width.
type Row = { start: number; end: number }

const COLUMNS_BEFORE_LAYOUT = 30
// Keys that are named, not typed, and do nothing here.
const UNUSED_KEYS = [
  'escape',
  'pageup',
  'pagedown',
  'insert',
  'wheelup',
  'wheeldown',
]

// Breaks the text into the rows drawn, each at most `columns` cells wide.
const layOut = (characters: string[], columns: number): Row[] => {
  const rows: Row[] = []
  let start = 0
  let cells = 0
  characters.forEach((character, index) => {
    if (character === '\n') {
      rows.push({ start, end: index })
      start = index + 1
      cells = 0

      return
    }
    const added = cellsOf(character)
    if (cells + added > columns) {
      rows.push({ start, end: index })
      start = index
      cells = 0
    }
    cells += added
  })
  rows.push({ start, end: characters.length })

  return rows
}

// A cursor at the seam of a wrapped line belongs to the row that starts there.
const rowOfCursor = (rows: Row[], cursor: number): number => {
  let found = 0
  rows.forEach((row, index) => {
    if (row.start <= cursor) found = index
  })

  return found
}

const cellsBefore = (characters: string[], row: Row, cursor: number): number =>
  characters
    .slice(row.start, cursor)
    .reduce((sum, character) => sum + cellsOf(character), 0)

// The cursor position in `row` nearest to `cells` from its left edge.
const cursorAt = (characters: string[], row: Row, cells: number): number => {
  let position = row.start
  let passed = 0
  while (position < row.end) {
    const next = passed + cellsOf(characters[position] ?? '')
    if (next > cells) break
    passed = next
    position += 1
  }

  return position
}

const NoteEditor: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text, Markdown } = surface.elements
  // The widest row leaves a cell for the cursor at its end.
  const columns =
    Math.max(
      8,
      surface.columns === 0 ? COLUMNS_BEFORE_LAYOUT : surface.columns,
    ) - 1

  const held = (): State =>
    surface.state ?? {
      text: props.text,
      cursor: Array.from(props.text).length,
    }

  const edit = (characters: string[], cursor: number): void => {
    const text = characters.join('')
    surface.setState({ text, cursor })
    surface.post({ text })
  }

  const move = (cursor: number): void => {
    surface.setState({ text: held().text, cursor })
  }

  surface.onKey((event: ClientKeyEvent) => {
    const { text, cursor } = held()
    const characters = Array.from(text)
    const rows = layOut(characters, columns)
    const rowIndex = rowOfCursor(rows, cursor)
    const row = rows[rowIndex] ?? { start: 0, end: 0 }
    const insert = (typed: string): void => {
      const added = Array.from(typed)
      edit(
        [...characters.slice(0, cursor), ...added, ...characters.slice(cursor)],
        cursor + added.length,
      )
    }
    const moveToRow = (target: Row | undefined): void => {
      if (target === undefined) return
      move(cursorAt(characters, target, cellsBefore(characters, row, cursor)))
    }

    if (event.meta === true) return
    if (event.ctrl === true) {
      if (event.key === 'a') move(row.start)
      if (event.key === 'e') move(row.end)
      if (event.key === 'k') {
        edit(
          [...characters.slice(0, cursor), ...characters.slice(row.end)],
          cursor,
        )
      }
      if (event.key === 'u') {
        edit(
          [...characters.slice(0, row.start), ...characters.slice(cursor)],
          row.start,
        )
      }

      return
    }

    switch (event.key) {
      case 'left':
        move(Math.max(0, cursor - 1))
        break
      case 'right':
        move(Math.min(characters.length, cursor + 1))
        break
      case 'up':
        moveToRow(rows[rowIndex - 1])
        break
      case 'down':
        moveToRow(rows[rowIndex + 1])
        break
      case 'home':
        move(row.start)
        break
      case 'end':
        move(row.end)
        break
      case 'backspace':
        if (cursor > 0) {
          edit(
            [...characters.slice(0, cursor - 1), ...characters.slice(cursor)],
            cursor - 1,
          )
        }
        break
      case 'delete':
        if (cursor < characters.length) {
          edit(
            [...characters.slice(0, cursor), ...characters.slice(cursor + 1)],
            cursor,
          )
        }
        break
      case 'return':
      case 'enter':
        insert('\n')
        break
      case 'tab':
        insert('  ')
        break
      case 'space':
        insert(' ')
        break
      default:
        if (UNUSED_KEYS.includes(event.key)) break
        if (/^f\d{1,2}$/.test(event.key)) break
        // A paste arrives as one key; its line ends become plain newlines.
        insert(event.key.replace(/\r\n?/g, '\n'))
    }
  })

  const { text, cursor } = held()
  const characters = Array.from(text)
  const rows = layOut(characters, columns)
  const cursorRow = rowOfCursor(rows, cursor)

  const drawRow = (row: Row, index: number) => {
    const line = characters.slice(row.start, row.end)
    if (index !== cursorRow) {
      return (
        <Box flexDirection="row">
          <Text>{line.length === 0 ? ' ' : line.join('')}</Text>
        </Box>
      )
    }
    const at = cursor - row.start

    return (
      <Box flexDirection="row">
        <Text>{line.slice(0, at).join('')}</Text>
        <Text inverse>{line[at] ?? ' '}</Text>
        <Text>{line.slice(at + 1).join('')}</Text>
        {text === '' && <Text dimColor> Write something…</Text>}
      </Box>
    )
  }

  // The lines of the text, each from `start` up to `end` in characters.
  const lines: Row[] = []
  let lineStart = 0
  characters.forEach((character, index) => {
    if (character !== '\n') return
    lines.push({ start: lineStart, end: index })
    lineStart = index + 1
  })
  lines.push({ start: lineStart, end: characters.length })
  const sourceOf = (line: Row): string =>
    characters.slice(line.start, line.end).join('')
  const isFence = (line: Row): boolean =>
    sourceOf(line).trimStart().startsWith('```')

  // The lines drawn as source: the cursor's own, or all of the fenced code
  // block it is in, which would not read as one with a line taken out.
  let firstSource = 0
  lines.forEach((line, index) => {
    if (line.start <= cursor) firstSource = index
  })
  let lastSource = firstSource
  const fencesBefore = lines.slice(0, firstSource).filter(isFence).length
  const cursorLine = lines[firstSource]
  const isInFence =
    fencesBefore % 2 === 1 || (cursorLine !== undefined && isFence(cursorLine))
  if (isInFence) {
    if (fencesBefore % 2 === 1) {
      while (firstSource > 0) {
        firstSource -= 1
        const line = lines[firstSource]
        if (line !== undefined && isFence(line)) break
      }
    }
    const opening = lines[firstSource]
    const isCursorOnClosing =
      fencesBefore % 2 === 1 && lastSource !== firstSource
        ? cursorLine !== undefined && isFence(cursorLine)
        : false
    if (opening !== undefined && !isCursorOnClosing) {
      while (lastSource < lines.length - 1) {
        lastSource += 1
        const line = lines[lastSource]
        if (line !== undefined && isFence(line)) break
      }
    }
  }

  const sourceStart = lines[firstSource]?.start ?? 0
  const sourceEnd = lines[lastSource]?.end ?? characters.length
  const before = characters.slice(0, Math.max(0, sourceStart - 1)).join('')
  const after = characters.slice(sourceEnd + 1).join('')
  const sourceRows = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.start >= sourceStart && row.start <= sourceEnd)

  const draw = ({ row, index }: { row: Row; index: number }) =>
    drawRow(row, index)

  return (
    <Box flexDirection="column">
      {before.trim() !== '' && <Markdown text={before} />}
      {sourceRows.map(draw)}
      {after.trim() !== '' && <Markdown text={after} />}
    </Box>
  )
}

export default NoteEditor
