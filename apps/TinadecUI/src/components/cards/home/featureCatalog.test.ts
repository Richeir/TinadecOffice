import { describe, expect, it } from 'vitest'
import { FEATURE_CATALOG } from './featureCatalog'

describe('FEATURE_CATALOG', () => {

  it('has no duplicate descriptor ids', () => {
    const ids = FEATURE_CATALOG.map((f) => f.descriptorId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // The workspace card is the only entry whose tile changes what the agent is authorized on,
  // so its presence and translation keys are pinned here rather than left to a screenshot.
  it('catalogs the workspace card with its own title and description keys', () => {
    const entry = FEATURE_CATALOG.find((f) => f.descriptorId === 'workspace')
    expect(entry).toBeTruthy()
    expect(entry!.titleKey).toBe('context.homeWorkspace')
    expect(entry!.descKey).toBe('context.homeWorkspaceDesc')
    expect(FEATURE_CATALOG.filter((f) => f.titleKey === entry!.titleKey)).toHaveLength(1)
  })

})
