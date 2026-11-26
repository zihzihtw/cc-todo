import type { ClientModule, ClientPointerEvent } from 'claude-code'

// The pane's free room under its rows while a todo is edited: a press on it
// is posted, which the hooks module takes as leaving the field.
const ClickAway: ClientModule = (_props, surface) => {
  const { Text } = surface.elements

  surface.onPointer((event: ClientPointerEvent) => {
    if (event.type === 'down') surface.post({ isAway: true })
  })

  return <Text> </Text>
}

export default ClickAway
