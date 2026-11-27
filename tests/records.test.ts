import { expect, test } from 'claude-code/testing'

import { cellsOf } from '../hooks/cells'
import { folderNameOf, toNote } from '../hooks/records'

test('a path is read down to its folder name', async () => {
  expect(folderNameOf('/Users/someone/git/cc-todo')).toBe('cc-todo')
  expect(folderNameOf('/Users/someone/git/cc-todo/')).toBe('cc-todo')
  expect(folderNameOf('/')).toBe('')
})

test('a record of now is read as it is', async () => {
  expect(
    toNote({
      folder: 'cc-todo',
      usedAt: 5,
      name: 'Fix the pane',
      isNameFromTitle: true,
      isNameCustom: true,
    }),
  ).toEqual({
    folder: 'cc-todo',
    usedAt: 5,
    name: 'Fix the pane',
    isNameFromTitle: true,
    isNameCustom: true,
  })
})

test('a record of an earlier version keeps its folder name and time alone', async () => {
  expect(
    toNote({ cwd: '/Users/someone/git/cc-todo', changedAt: 5, name: 'fix th' }),
  ).toEqual({ folder: 'cc-todo', usedAt: 5 })
})

test('what does not read as a record is none', async () => {
  expect(toNote(undefined)).toBeUndefined()
  expect(toNote('note')).toBeUndefined()
  expect(toNote({ usedAt: 5 })).toBeUndefined()
  expect(toNote({ folder: 'cc-todo', usedAt: 'yesterday' })).toBeUndefined()
})

test('a wide character takes two cells', async () => {
  expect(cellsOf('todo')).toBe(4)
  expect(cellsOf('待辦事項')).toBe(8)
  expect(cellsOf('ok 好 🎉')).toBe(8)
})
