// @vitest-environment happy-dom
/**
 * The column's drag handle has to straddle the seam, and that is a DOM contract, not
 * a CSS one: `.uie-column` must not clip its child, so the handle is a sibling of the
 * clipped box instead of living inside it. When it sat inside `.uie-column` with
 * `overflow:hidden`, half of its 12px grab strip fell outside the clip and was dead to
 * the pointer (measured: 4 of 8 px reachable), while the visible pill hugged the inner
 * edge of the panel.
 *
 * happy-dom resolves no stylesheet, so the geometry itself is verified in a browser
 * (`.tinadec_dev/evidence/2026-10-21-resizer-ownership/`); what this file pins is the
 * structure that makes the geometry possible, plus where the handle may exist at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import UieColumn from '../../../TinadecUI/src/components/UieColumn.vue'
import type { UieColumn as ColumnModel } from '../../../TinadecUI/src/engine/types'

// The column reads the card registry off the store to decide whether it hosts the
// feature panel (only that one has a collapsed rail). Hoisted so the mock factory can
// reach it, and mutated per test to seed or clear the pinned homePicker card.
const store = vi.hoisted(() => ({ cards: {} as Record<string, { id: string; descriptorId: string }> }))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../../../TinadecUI/src/components/UieStack.vue', () => ({ default: { name: 'UieStack', render: () => null } }))
vi.mock('../../../TinadecUI/src/components/UieDock.vue', () => ({ default: { name: 'UieDock', render: () => null } }))
vi.mock('../../../TinadecUI/src/components/cardTitle', () => ({ useCardTitle: () => () => 'title' }))
vi.mock('../../../TinadecUI/src/components/cards/home/featureCatalog', () => ({ featureIconFor: () => null }))
vi.mock('@/composables/usePanelStyles', () => ({
  usePanelStyles: () => ({ getPanelStyle: () => ({}), getPanelDataAttributes: () => ({}) }),
}))
vi.mock('@/composables/useDockDrag', () => ({ useDockDrag: () => ({ registerDock: () => () => {} }) }))
vi.mock('../../../TinadecUI/src/components/useUie', () => ({
  useUie: () => ({
    snapshot: ref({ cards: store.cards, revision: 1 }),
    scope: ref('user'),
    containerSize: ref({ width: 1280, height: 800 }),
    bus: { dispatch: vi.fn() },
  }),
}))

afterEach(() => { for (const key of Object.keys(store.cards)) delete store.cards[key] })

function column(slotId: 'left' | 'center' | 'right', overrides: Partial<ColumnModel> = {}): ColumnModel {
  return {
    slotId,
    width: 280,
    collapsed: false,
    surfaceMode: 'float',
    topInset: 8,
    primary: { stackId: 'primary', tabIds: [], activeTabId: null },
    secondary: null,
    splitRatio: null,
    dock: null,
    ...overrides,
  }
}

/** A column that hosts the pinned homePicker card — i.e. the feature panel. */
function featureColumn(slotId: 'left' | 'right', overrides: Partial<ColumnModel> = {}): ColumnModel {
  store.cards['home-1'] = { id: 'home-1', descriptorId: 'homePicker' }
  return column(slotId, { primary: { stackId: 'primary', tabIds: ['home-1'], activeTabId: 'home-1' }, ...overrides })
}

function mountColumn(model: ColumnModel) {
  return mount(UieColumn, {
    props: {
      column: model,
      geometry: { slotId: model.slotId, x: 0, y: 0, width: model.width, height: 600, effectiveWidth: model.width, topInset: 8, overlay: false },
    },
  })
}

describe('UieColumn drag handle', () => {
  it('keeps the handle outside the clipped box so both halves of it stay grabbable', () => {
    const wrapper = mountColumn(column('left'))
    const root = wrapper.get('.uie-column')
    const clip = root.get('.uie-column-clip')
    const handle = root.get('.uie-column-resizer')

    // Sibling of the clip, not a descendant: a clipped handle still looks right but
    // stops receiving pointer events on the gutter half.
    expect(handle.element.parentElement).toBe(root.element)
    expect(clip.findAll('.uie-column-resizer')).toHaveLength(0)
  })

  it('anchors the left column to its right edge and the right column to its left edge', () => {
    const left = mountColumn(column('left')).get('.uie-column-resizer')
    const right = mountColumn(column('right')).get('.uie-column-resizer')
    expect(left.classes()).toContain('uie-column-resizer-right')
    expect(right.classes()).toContain('uie-column-resizer-left')
  })

  it('has no handle on the centre column, which has no edge to drag', () => {
    expect(mountColumn(column('center')).find('.uie-column-resizer').exists()).toBe(false)
  })

  it('drops the handle while the feature panel shows its collapsed rail', () => {
    // An icon rail has no width worth dragging; it also hides during the collapse
    // animation, where a 12px strip over the seam would catch stray clicks.
    const wrapper = mountColumn(featureColumn('right', { collapsed: true }))
    expect(wrapper.find('.uie-column-rail').exists()).toBe(true)
    expect(wrapper.find('.uie-column-resizer').exists()).toBe(false)
  })
})
