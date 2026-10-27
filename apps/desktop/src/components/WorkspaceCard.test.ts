// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

// The card body is another slice's component; this file only pins the wiring between the
// registry entry and the panel, so the controller graph is never built here.
vi.mock('@/controllers/HomeController', () => ({ homeController: {} }))

import WorkspaceCard from '../../../TinadecUI/src/components/cards/home/WorkspaceCard.vue'

const PanelStub = { name: 'WorkspaceRootsPanel', template: '<div class="roots-panel-stub" />' }

describe('workspace feature card', () => {
  it('renders the source-folder panel as its body', () => {
    const wrapper = mount(WorkspaceCard, { global: { stubs: { WorkspaceRootsPanel: PanelStub } } })
    expect(wrapper.find('.roots-panel-stub').exists()).toBe(true)
  })
})
