import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `createCardRegistry` throws on a duplicate `type`, and the throw happens while the layout
 * engine is being built — the window renders nothing and the console shows
 * `CardRegistry: duplicate descriptor type '…'`. Nothing else in the suite builds the real
 * registry (importing the `@tinadec/ui` barrel drags in controllers that open event streams),
 * so this reads the descriptor table instead: a duplicate is one line too many in one array,
 * and a source scan is enough to catch it before the app does.
 */
const registrySource = readFileSync(
  fileURLToPath(new URL('../../../TinadecUI/src/components/cards/index.ts', import.meta.url)),
  'utf8',
)

function descriptorTypes(): string[] {
  return [...registrySource.matchAll(/\{\s*type:\s*'([^']+)'/g)].map((match) => match[1]!)
}

describe('UIE card registry', () => {
  it('declares every descriptor type exactly once', () => {
    const types = descriptorTypes()
    expect(types.length).toBeGreaterThan(0)
    expect(new Set(types).size).toBe(types.length)
  })

  it('keeps the read-only viewer and the code editor as separate cards', () => {
    const types = descriptorTypes()
    expect(types).toContain('docReader')
    expect(types).toContain('codeEditor')
  })
})
