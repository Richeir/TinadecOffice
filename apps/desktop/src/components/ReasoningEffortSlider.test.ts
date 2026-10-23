// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en'
import ReasoningEffortSlider from '@/components/ReasoningEffortSlider.vue'
import type { ReasoningEffortChoice } from '@/lib/reasoningEffort'

const i18n = () => createI18n({ legacy: false, locale: 'en', messages: { en } })

/** The slider with a v-model-ish parent, so the internal position and the prop stay in step. */
function mountSlider(modelValue: ReasoningEffortChoice = 'low') {
  const wrapper = mount(ReasoningEffortSlider, {
    props: { modelValue, 'onUpdate:modelValue': (value: ReasoningEffortChoice) => wrapper.setProps({ modelValue: value }) },
    global: { plugins: [i18n()] },
  })
  const slider = wrapper.get('[data-testid="reasoning-slider"]')
  return { wrapper, slider, input: slider.element as HTMLInputElement }
}

describe('reasoning effort slider', () => {
  it('drags free between stops and snaps to the nearest one on release', async () => {
    const { wrapper, slider, input } = mountSlider('low')
    await slider.trigger('pointerdown')
    input.value = '3.37'
    await slider.trigger('input')
    expect(input.value).toBe('3.37')
    expect(wrapper.emitted('commit')).toBeUndefined()

    input.value = '3.62'
    await slider.trigger('change')
    expect(input.value).toBe('4')
    expect(wrapper.emitted('commit')).toEqual([['high']])
    expect(wrapper.get('.reasoning-slider-value').text()).toBe('High')
  })

  it('moves a whole stop per key and lights the matrix only on the top stop', async () => {
    const { wrapper, slider, input } = mountSlider('low')
    await slider.trigger('keydown', { key: 'ArrowRight' })
    expect(input.value).toBe('3')
    expect(wrapper.emitted('commit')).toEqual([['medium']])

    await slider.trigger('keydown', { key: 'End' })
    expect(input.value).toBe('5')
    expect(wrapper.attributes('data-apex')).toBe('true')
    expect(wrapper.find('.reasoning-slider-surge').exists()).toBe(true)
  })
})
