// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en'
import ChatHeader from './ChatHeader.vue'

function mountHeader(title: string | null = 'Test session') {
  return mount(ChatHeader, {
    global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] },
    props: {
      currentSession: title === null
        ? null
        : { id: 's1', title, project_id: 'p1', status: 'active', created_at: '', updated_at: '', permission_mode: 'default', space_options: null, settings_revision: 0 },
    },
  })
}

/**
 * The header used to render one pill per non-terminal run — the only "planning / executing /
 * waiting" readout outside the transcript. Status moved into the conversation flow (the work
 * fold's live line, the plan node, the waiting line, the supervision gate), so the header must
 * stay a title: a second status vocabulary up here competes with the flow and can disagree
 * with it. This guards the removal rather than the old pills.
 */
describe('ChatHeader', () => {
  it('shows the session title', async () => {
    const wrapper = mountHeader('My conversation')
    await flushPromises()
    expect(wrapper.find('h1').text()).toBe('My conversation')
    wrapper.unmount()
  })

  it('falls back to the generic chat title without a session', async () => {
    const wrapper = mountHeader(null)
    await flushPromises()
    expect(wrapper.find('h1').exists()).toBe(true)
    wrapper.unmount()
  })

  it('renders no run status of its own, whatever the run list holds', async () => {
    const wrapper = mountHeader()
    await flushPromises()
    const html = wrapper.html()
    // Neither the old pills nor any state word leaks back into the header.
    expect(wrapper.find('[data-testid="run-pills"]').exists()).toBe(false)
    expect(wrapper.find('.run-pill').exists()).toBe(false)
    for (const word of ['planning', 'executing', 'awaiting', 'Plan', 'Running', 'Waiting']) {
      expect(html).not.toContain(word)
    }
    wrapper.unmount()
  })
})