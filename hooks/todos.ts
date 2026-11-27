import type { Todo } from '../types'

// The store outlives the code that wrote it, so what it holds is checked
// before it is trusted.
export const toTodos = (stored: unknown): Todo[] => {
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

const highestId = (list: Todo[]): number =>
  list.reduce((max, one) => Math.max(max, one.id), 0)

export const add =
  (text: string) =>
  (list: Todo[]): Todo[] => [
    ...list,
    { id: highestId(list) + 1, text, isDone: false },
  ]

// Puts the todos of another list after a list's own, under ids of their own:
// the two lists numbered their todos apart, so the same id may be in both.
export const adopt =
  (others: Todo[]) =>
  (list: Todo[]): Todo[] => {
    const from = highestId(list)

    return [
      ...list,
      ...others.map((one, index) => ({ ...one, id: from + index + 1 })),
    ]
  }

// Moves the todo `id` by `steps` places among the todos that are done as it
// is (the pane lists the open ones, then the done ones).
export const moveBy =
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
