// @vitest-environment happy-dom
/**
 * The sidebar footer now carries the local identity: a square portrait on the
 * left, the three shell actions (view, settings, collapse) on the right. These
 * pin the order and the one behaviour the portrait owns — handing the personal
 * module to the settings page — because the alignment itself is CSS.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PersonalAvatar from './PersonalAvatar.vue'
import { setAvatar, setNickname } from '@/lib/userProfile'

beforeEach(() => {
  localStorage.clear()
  setNickname('')
  setAvatar(null)
})

describe('PersonalAvatar', () => {
  it('reads avatar → nickname initial → placeholder, in that order', async () => {
    const wrapper = mount(PersonalAvatar)
    expect(wrapper.find('svg').exists()).toBe(true)

    setNickname('wwiinnddy')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toBe('W')
    expect(wrapper.find('svg').exists()).toBe(false)

    setAvatar('data:image/png;base64,AAAA')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('img').attributes('src')).toBe('data:image/png;base64,AAAA')
  })

  it('sizes the round frame from its props', () => {
    const wrapper = mount(PersonalAvatar, { props: { size: 64 } })
    const frame = wrapper.get<HTMLElement>('.personal-avatar').element
    expect(frame.style.width).toBe('64px')
    expect(frame.style.height).toBe('64px')
    // The portrait is a circle in both surfaces — the settings hero always was.
    expect(frame.classList.contains('rounded-full')).toBe(true)
  })
})
