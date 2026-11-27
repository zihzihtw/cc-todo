import { expect, test } from 'claude-code/testing'

import { titlesIn, wholeLines } from '../hooks/title'

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

const generated = (title: string): string =>
  `${JSON.stringify({ type: 'ai-title', aiTitle: title })}\n`

const custom = (title: string): string =>
  `${JSON.stringify({ type: 'custom-title', customTitle: title })}\n`

test('title rows are read by kind, and other rows passed over', async () => {
  expect(
    titlesIn(generated('one') + custom('two') + generated('three')),
  ).toEqual({ custom: 'two', generated: 'three' })
  expect(titlesIn('{"type":"ai-title","aiTitle":\n' + generated(''))).toEqual(
    {},
  )
  expect(
    titlesIn('{"type":"user","text":"an -title\\" in a prompt"}\n'),
  ).toEqual({})
})

test('a range gives its whole lines, cut by byte', async () => {
  const bytes = bytesOf('好\n中間\n尾')

  // The first character's last two bytes lead the range, cut.
  expect(wholeLines(bytes.subarray(1), false)).toEqual({
    text: '中間\n',
    from: 3,
    to: 10,
  })
  expect(wholeLines(bytes, true)).toEqual({
    text: '好\n中間\n',
    from: 0,
    to: 11,
  })
  expect(wholeLines(bytesOf('no line end'), true)).toBeUndefined()
  expect(wholeLines(bytesOf('only\n'), false)).toEqual({
    text: '',
    from: 5,
    to: 5,
  })
})
