// East Asian wide and fullwidth characters, and emoji, take two cells.
const isWide = (codePoint: number): boolean =>
  (codePoint >= 0x1100 && codePoint <= 0x115f) ||
  (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
  (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
  (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
  (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
  (codePoint >= 0xff00 && codePoint <= 0xff60) ||
  (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
  (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
  (codePoint >= 0x20000 && codePoint <= 0x3fffd)

// The cells a text takes in the terminal: one a character, two a wide one.
export const cellsOf = (text: string): number =>
  Array.from(text).reduce(
    (sum, character) => sum + (isWide(character.codePointAt(0) ?? 0) ? 2 : 1),
    0,
  )
