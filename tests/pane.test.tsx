import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const WINDOW = 262144
const MIB = 1048576

const PANE = {
  plugin: 'cc-todo',
  component: 'Pane',
  requestId: 'cc-todo',
  props: {
    title: 'Todo',
    isFocused: false,
    bodyColumns: 34,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

const base64Of = (bytes: Uint8Array): string => {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 32768) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 32768))
  }

  return btoa(binary)
}

// Rows of a transcript that hold no title, `count` bytes of them.
const rowsOf = (count: number): string => {
  const row = `{"type":"assistant","text":"${'x'.repeat(70)}"}\n`
  const whole = row.repeat(Math.floor(count / row.length))

  return whole + 'y'.repeat(count - whole.length - 1) + '\n'
}

const generated = (title: string): string =>
  `${JSON.stringify({ type: 'ai-title', aiTitle: title })}\n`

const custom = (title: string): string =>
  `${JSON.stringify({ type: 'custom-title', customTitle: title })}\n`

// What sits beneath the plugin in a session: its id, a store, and a
// transcript whose every read is counted.
const session = (
  on: On,
  { id, text, stored = {} }: { id: string; text: string; stored?: object },
) => {
  const store = new Map<string, unknown>(Object.entries(stored))
  const file = { bytes: bytesOf(text), text, reads: [] as number[] }

  on('command.register', () => ({ value: { command: 'todo' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: id }))
  on('session.cwd', () => ({ value: '/Users/someone/git/cc-todo' }))
  on('session.info', () => ({ value: { transcriptPath: `/t/${id}.jsonl` } }))
  on('clock.now', () => ({ value: 1000 }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('prompt.change', (_, e) => ({ text: e.text }) as never)
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('fs.stat', () => ({
    value: { kind: 'file', size: file.bytes.length, mtimeMs: 0, isLink: false },
  }))
  on('fs.read', (_, e) => {
    const from = e.offset ?? 0
    const to = from + (e.length ?? file.bytes.length)
    file.reads.push(to - from)

    return { value: { base64: base64Of(file.bytes.subarray(from, to)) } }
  })

  return {
    store,
    reads: file.reads,
    write: (more: string) => {
      file.text += more
      file.bytes = bytesOf(file.text)
    },
  }
}

const start = ($: Engine) =>
  $.session.start({
    cwd: '/Users/someone/git/cc-todo',
    surface: 'terminal',
    isInteractive: true,
  })

// A prompt sent: the session's name is read again.
const prompt = ($: Engine) =>
  $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })

// The name on this session's card, as the pane draws it: the bold line that
// is not the pane's own tab.
const nameShown = async ($: Engine): Promise<string | undefined> => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()

  return texts.find(one => one.props.bold === true && one.text !== 'Todo')?.text
}

test('a session holding nothing is named by its title', async ($, on) => {
  const held = session(on, {
    id: 'given',
    text: rowsOf(2000) + custom('Mine') + generated('Made'),
  })
  await start($)

  expect(await nameShown($)).toBe('Mine')
  // Nothing is kept for it.
  expect([...held.store.keys()]).toEqual([])
})

test('a session with no title is untitled', async ($, on) => {
  session(on, { id: 'none', text: rowsOf(2000) })
  await start($)

  expect(await nameShown($)).toBe('Untitled session')
})

test('a title cut by a read is read whole by the next', async ($, on) => {
  // The newest read starts inside the title's characters.
  const held = session(on, {
    id: 'cut',
    text: rowsOf(5000) + generated('整理待辦清單的面板') + rowsOf(WINDOW - 20),
  })
  await start($)

  expect(await nameShown($)).toBe('整理待辦清單的面板')
  expect(held.reads.length).toBe(2)
})

test('a title before a row longer than a read is found', async ($, on) => {
  const long = `{"type":"user","image":"${'i'.repeat(3 * WINDOW)}"}\n`
  session(on, { id: 'long', text: generated('Before') + long + rowsOf(1000) })
  await start($)

  expect(await nameShown($)).toBe('Before')
})

test('a later reading takes only what was written since', async ($, on) => {
  const held = session(on, {
    id: 'since',
    text: generated('First') + rowsOf(4000),
  })
  await start($)
  expect(await nameShown($)).toBe('First')
  expect(held.reads.length).toBe(1)

  // Nothing written: nothing read, and the title stands.
  await prompt($)
  expect(await nameShown($)).toBe('First')
  expect(held.reads.length).toBe(1)

  held.write(rowsOf(600))
  await prompt($)
  expect(await nameShown($)).toBe('First')
  expect(held.reads.slice(1)).toEqual([600])

  held.write(generated('Second') + '{"type":"ai-title","aiTi')
  await prompt($)
  expect(await nameShown($)).toBe('Second')

  // The row that was being written is read once it is whole.
  held.write('tle":"Third"}\n')
  await prompt($)
  expect(await nameShown($)).toBe('Third')
})

test('the search for a title stops at its bound', async ($, on) => {
  const held = session(on, {
    id: 'far',
    text: generated('Far') + rowsOf(9 * MIB),
  })
  await start($)

  expect(await nameShown($)).toBe('Untitled session')
  // Each read takes again the line the one after it started inside, so a
  // little more than the bound is read, and far less than all of it.
  const read = held.reads.reduce((sum, one) => sum + one, 0)
  expect(read >= 8 * MIB && read < 8 * MIB + WINDOW).toBe(true)

  // Searched once: the next reading takes nothing more.
  const reads = held.reads.length
  await prompt($)
  expect(held.reads.length).toBe(reads)
})

test('todos of the shared list follow the ones the session has', async ($, on) => {
  const held = session(on, {
    id: 'adopter',
    text: generated('Adopter'),
    stored: {
      items: [
        { id: 1, text: 'shared one', isDone: false },
        { id: 2, text: 'shared two', isDone: true },
      ],
      'items:adopter': [{ id: 1, text: 'own one', isDone: false }],
    },
  })
  await start($)

  expect(held.store.get('items:adopter')).toEqual([
    { id: 1, text: 'own one', isDone: false },
    { id: 2, text: 'shared one', isDone: false },
    { id: 3, text: 'shared two', isDone: true },
  ])
  expect(held.store.has('items')).toBe(false)
})

test('a note typed in the editor is kept as it is typed', async ($, on) => {
  const held = session(on, { id: 'noted', text: generated('Noting') })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-note' })
  for (const key of ['#', 'space', '待', '辦', 'return', 'o', 'k']) {
    await ui.key({ key, in: 'note-noted' })
  }
  expect(held.store.get('text:noted')).toBe('# 待辦\nok')

  await ui.key({ key: 'backspace', in: 'note-noted' })
  expect(held.store.get('text:noted')).toBe('# 待辦\no')
  await ui.unmount()
})

test('a todo typed in the pane is kept, with a record of its session', async ($, on) => {
  const held = session(on, { id: 'typed', text: generated('Typing') })
  await start($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.input({ key: 'new-todo', text: `on ${surface}` })
    expect(await ui.find({ type: 'Text', text: `on ${surface}` })).toBeDefined()
    await ui.unmount()
  }

  expect(held.store.get('items:typed')).toEqual([
    { id: 1, text: 'on terminal', isDone: false },
    { id: 2, text: 'on desktop', isDone: false },
  ])
  expect(held.store.get('note:typed')).toEqual({
    folder: 'cc-todo',
    usedAt: 1000,
    name: 'Typing',
    isNameFromTitle: true,
  })
})

test('the note shows its cursor only while it has the keyboard', async ($, on) => {
  session(on, {
    id: 'held',
    text: generated('Held'),
    stored: { 'text:held': '# 待辦\n- one' },
  })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-note' })
  const cursor = async () =>
    (await ui.findAll({ type: 'Text', in: 'note-held' })).find(
      one => one.props.inverse === true,
    )
  const read = () => ui.find({ type: 'Markdown', in: 'note-held' })

  // At rest the note reads whole, with no cursor.
  expect(await cursor()).toBeUndefined()
  expect((await read())?.props.text).toBe('# 待辦\n- one')

  // A click gives it the keyboard: the cursor shows, on a line of source.
  await ui.pointer({ type: 'down', x: 0, y: 0, in: 'note-held' })
  expect(await cursor()).toBeDefined()
  expect((await read())?.props.text).toBe('# 待辦')

  // Pressing anything else in the pane takes the keyboard away.
  await ui.press({ key: 'toggle-scope' })
  expect(await cursor()).toBeUndefined()
  expect((await read())?.props.text).toBe('# 待辦\n- one')

  // A key that reaches it shows it has the keyboard again.
  await ui.key({ key: '!', in: 'note-held' })
  expect(await cursor()).toBeDefined()

  // A click on the free room under the note takes it away too.
  await ui.pointer({ type: 'down', x: 0, y: 0, in: 'click-away' })
  expect(await cursor()).toBeUndefined()
  await ui.pointer({ type: 'down', x: 0, y: 0, in: 'note-held' })
  expect(await cursor()).toBeDefined()

  // So does typing in the prompt take it away.
  const typing = $.prompt as unknown as {
    change: (e: { text: string }) => Promise<unknown>
  }
  await typing.change({ text: 'a' })
  expect(await cursor()).toBeUndefined()
  expect((await read())?.props.text).toBe('# 待辦\n- one!')

  // Escape hands the keyboard back with nothing raised: the pane losing it
  // is what shows, once a key reached the editor while the pane had it.
  await ui.redraw({ ...PANE.props, isFocused: true })
  await ui.key({ key: '?', in: 'note-held' })
  expect(await cursor()).toBeDefined()
  await ui.redraw({ ...PANE.props, isFocused: false })
  expect(await cursor()).toBeUndefined()
  await ui.redraw({ ...PANE.props, isFocused: true })
  expect(await cursor()).toBeDefined()
  await ui.unmount()
})

test('what is half typed is still in its field when the pane comes back', async ($, on) => {
  session(on, {
    id: 'away',
    text: generated('Away'),
    stored: { 'items:away': [{ id: 1, text: 'kept', isDone: false }] },
  })
  await start($)

  for (const surface of ['terminal', 'desktop'] as const) {
    // Typed, with nothing sent, then the pane leaves the screen.
    const before = await $.ui.mount({ ...PANE, surface })
    await before.input({ key: 'new-todo', text: 'half a todo', kind: 'change' })
    await before.press({ key: 'edit-button-away-1' })
    await before.input({ key: 'edit-away-1', text: 'kept and', kind: 'change' })
    await before.unmount()

    const after = await $.ui.mount({ ...PANE, surface })
    const held = async (key: string) => (await after.find({ key }))?.props.value
    expect(await held('new-todo')).toBe('half a todo')
    expect(await held('edit-away-1')).toBe('kept and')

    // Cancelled, the todo is as it was kept, and so is its field next time.
    await after.press({ key: 'cancel-edit-away-1' })
    await after.press({ key: 'edit-button-away-1' })
    expect(await held('edit-away-1')).toBe('kept')
    await after.press({ key: 'cancel-edit-away-1' })
    await after.input({ key: 'new-todo', text: '' })
    await after.unmount()
  }
})
