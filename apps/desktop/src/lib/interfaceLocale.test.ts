import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { interfaceLocale } from './interfaceLocale'

describe('interfaceLocale', () => {
  afterEach(() => {
    i18n.global.locale.value = 'zh-CN'
  })

  it('reports the active UI locale and normalizes it to Core vocabulary', () => {
    i18n.global.locale.value = 'en'
    expect(interfaceLocale()).toBe('en')
    i18n.global.locale.value = 'zh-TW'
    expect(interfaceLocale()).toBe('zh-TW')
    i18n.global.locale.value = 'zh-CN'
    expect(interfaceLocale()).toBe('zh-CN')
  })
})
