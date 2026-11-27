import type { EngineInterface } from 'claude-code'

export type Title = { text: string; isCustom: boolean }

// The titles a stretch of the transcript holds, the last of each kind.
type Titles = { custom?: string; generated?: string }

// How much of the transcript one read takes. The engine writes the title
// again as the session goes on, so one read from the end mostly finds it.
const WINDOW_BYTES = 262144
// How far back from the transcript's end a title is looked for where the
// end holds none: a long turn can write more than one read after the last.
// Bounded, as a hook has seconds to answer and a transcript can be large.
const SEARCH_BYTES = 8388608
const NEWLINE = 0x0a

// The transcript's rows are the engine's own format, so a row that does not
// read as expected is passed over.
export const titlesIn = (text: string): Titles => {
  const titles: Titles = {}
  for (const line of text.split('\n')) {
    if (!line.includes('-title"')) continue
    try {
      const row: unknown = JSON.parse(line)
      if (typeof row !== 'object' || row === null) continue
      if (
        'customTitle' in row &&
        typeof row.customTitle === 'string' &&
        row.customTitle !== ''
      ) {
        titles.custom = row.customTitle
      }
      if (
        'aiTitle' in row &&
        typeof row.aiTitle === 'string' &&
        row.aiTitle !== ''
      ) {
        titles.generated = row.aiTitle
      }
    } catch {
      // Not a row of JSON: nothing to read from it.
    }
  }

  return titles
}

// The whole lines among `bytes`, a range of a file that may start and end
// inside a line, with where they start and end within it; none where the
// range holds no line end. `isAtLineStart` says the range starts a line.
// Lines are cut by byte, so no character is cut with them.
export const wholeLines = (
  bytes: Uint8Array,
  isAtLineStart: boolean,
): { text: string; from: number; to: number } | undefined => {
  const last = bytes.lastIndexOf(NEWLINE)
  if (last === -1) return undefined
  const from = isAtLineStart ? 0 : bytes.indexOf(NEWLINE) + 1
  const to = last + 1

  return {
    text: from < to ? new TextDecoder().decode(bytes.subarray(from, to)) : '',
    from,
    to,
  }
}

// A function declaration, as `readTitle` is: the engine follows `$` past an
// import only into one.
async function readBytes(
  $: EngineInterface,
  path: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const read = await $.fs.read(path, { as: 'bytes', offset, length })
  if (typeof read === 'string') return new TextEncoder().encode(read)

  return Uint8Array.from(atob(read.base64), character =>
    character.charCodeAt(0),
  )
}

// What has been read of a transcript: the titles found in it, and how far
// it was read, which is the start of a line. A later reading takes only what
// was written since, so a session is not searched again on every prompt.
let scanned: { path: string; offset: number; titles: Titles } | undefined

// The title the resume list shows, read from the session's transcript: the
// one given with /rename, else the generated one; no title is an answer.
//
// The transcript is read backwards from its end, a window at a time, until a
// window holds a title, down to where the last reading stopped or the search
// bound, whichever comes first.
export async function readTitle(
  $: EngineInterface,
): Promise<Title | undefined> {
  try {
    const { transcriptPath: path } = await $.session.info()
    if (path === '') return undefined
    const { size } = await $.fs.stat(path)
    // Another transcript, or one that shrank, is read from nothing.
    const held =
      scanned !== undefined && scanned.path === path && scanned.offset <= size
        ? scanned
        : { path, offset: 0, titles: {} }
    const floor = Math.max(held.offset, size - SEARCH_BYTES)

    let found: Titles = {}
    let readTo: number | undefined
    let end = size
    while (end > floor) {
      const start = Math.max(floor, end - WINDOW_BYTES)
      const bytes = await readBytes($, path, start, end - start)
      const lines = wholeLines(bytes, start === held.offset)
      if (lines === undefined) {
        // All of it is inside one line, which goes on before it.
        end = start
        continue
      }
      // The newest line end met: what follows it is a row still being
      // written, left to the next reading.
      readTo ??= start + lines.to
      found = titlesIn(lines.text)
      if (found.custom !== undefined || found.generated !== undefined) break
      // The line the window starts inside is whole in the window before it.
      // Where that line fills the window, the window before ends inside it.
      end = lines.from < bytes.length ? start + lines.from : start
    }

    const titles: Titles = { ...held.titles, ...found }
    scanned = { path, offset: readTo ?? held.offset, titles }
    if (titles.custom !== undefined) {
      return { text: titles.custom, isCustom: true }
    }
    if (titles.generated !== undefined) {
      return { text: titles.generated, isCustom: false }
    }

    return undefined
  } catch {
    return undefined
  }
}
