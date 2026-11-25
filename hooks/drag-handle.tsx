import type { ClientModule, ClientPointerEvent } from 'claude-code'

// The handle a todo is dragged by. It is one cell on the todo's first line;
// while the pointer is held it keeps receiving the pointer's row, which may
// be above or below its own, and posts how many todos away that is: on each
// change while held, and once more, as dropped, when the button comes up.

// How many lines this todo and the todos around it take, nearest first.
type Props = { own: number; before: number[]; after: number[] }
type State = { isHeld: boolean; steps: number }

// How many todos away the pointer is, from its row relative to the handle:
// negative above, positive below.
const stepsAt = (y: number, props: Props): number => {
  if (y >= 0) {
    let rest = y - props.own
    if (rest < 0) return 0
    let steps = 0
    for (const lines of props.after) {
      steps += 1
      rest -= lines
      if (rest < 0) return steps
    }

    return props.after.length
  }

  let rest = -y
  let steps = 0
  for (const lines of props.before) {
    steps -= 1
    rest -= lines
    if (rest <= 0) return steps
  }

  return -props.before.length
}

const DragHandle: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  const held = (): State => surface.state ?? { isHeld: false, steps: 0 }

  surface.onPointer((event: ClientPointerEvent) => {
    if (event.type === 'down') {
      surface.setState({ isHeld: true, steps: 0 })
      surface.post({ steps: 0, isDropped: false })

      return
    }
    if (!held().isHeld) return
    if (event.type === 'move') {
      const steps = stepsAt(event.y, props)
      if (steps === held().steps) return
      surface.setState({ isHeld: true, steps })
      surface.post({ steps, isDropped: false })
    }
    if (event.type === 'up') {
      surface.post({ steps: stepsAt(event.y, props), isDropped: true })
      surface.setState({ isHeld: false, steps: 0 })
    }
  })

  return held().isHeld ? (
    <Text color="#e8825a">≡</Text>
  ) : (
    <Text dimColor>≡</Text>
  )
}

export default DragHandle
