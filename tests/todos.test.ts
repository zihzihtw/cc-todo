import { expect, test } from 'claude-code/testing'

import { add, adopt, moveBy, toTodos } from '../hooks/todos'

const todo = (id: number, isDone = false) => ({
  id,
  text: `todo ${id}`,
  isDone,
})

test('what is stored is read as todos only where it reads as them', async () => {
  expect(toTodos(undefined)).toEqual([])
  expect(toTodos('todos')).toEqual([])
  expect(
    toTodos([
      todo(1),
      null,
      { id: '2', text: 'an id that is no number', isDone: false },
      { id: 3, text: 'kept', isDone: true, extra: 'dropped' },
    ]),
  ).toEqual([todo(1), { id: 3, text: 'kept', isDone: true }])
})

test('a new todo takes the id after the highest', async () => {
  expect(add('first')([])).toEqual([{ id: 1, text: 'first', isDone: false }])
  expect(add('next')([todo(4), todo(2)]).map(one => one.id)).toEqual([4, 2, 5])
})

test('adopted todos follow the list under ids of their own', async () => {
  const adopted = adopt([todo(1), todo(2, true)])([todo(1), todo(2)])

  expect(adopted.map(one => one.id)).toEqual([1, 2, 3, 4])
  expect(adopted.map(one => one.text)).toEqual([
    'todo 1',
    'todo 2',
    'todo 1',
    'todo 2',
  ])
  expect(adopted[3]?.isDone).toBe(true)
  expect(adopt([todo(7)])([])).toEqual([{ ...todo(7), id: 1 }])
})

test('a todo moves among those done as it is', async () => {
  const list = [todo(1), todo(2, true), todo(3), todo(4, true), todo(5)]
  const ids = (moved: typeof list) => moved.map(one => one.id)

  // Down one place among the open todos, past the done one between them.
  expect(ids(moveBy(1, 1)(list))).toEqual([2, 3, 1, 4, 5])
  expect(ids(moveBy(5, -2)(list))).toEqual([5, 1, 2, 3, 4])
  expect(ids(moveBy(4, -1)(list))).toEqual([1, 4, 2, 3, 5])
})

test('a move past either end stops there, and one to nowhere changes nothing', async () => {
  const list = [todo(1), todo(2), todo(3)]

  expect(moveBy(1, 9)(list).map(one => one.id)).toEqual([2, 3, 1])
  expect(moveBy(3, -9)(list).map(one => one.id)).toEqual([3, 1, 2])
  expect(moveBy(2, 0)(list)).toBe(list)
  expect(moveBy(1, -1)(list)).toBe(list)
  expect(moveBy(8, 1)(list)).toBe(list)
})
