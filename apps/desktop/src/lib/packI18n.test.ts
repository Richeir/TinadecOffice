import { describe, expect, it } from 'vitest'
import { localeFallbackChain, normalizeLocale, pickLocalized, pickNodeLabel } from './packI18n'

const overlays = {
  'zh-CN': { display_name: '搜索', description: '基础版', label: '检索' },
  'zh-TW': { display_name: '搜尋' },
  en: { display_name: 'Search', description: 'Baseline edition' },
  ja: { display_name: '' },
}

describe('packI18n', () => {
  it('normalizes locales exactly as Core does', () => {
    expect(normalizeLocale('en')).toBe('en')
    expect(normalizeLocale('EN')).toBe('en')
    expect(normalizeLocale('en-US')).toBe('en')
    expect(normalizeLocale('zh-HK')).toBe('zh-TW')
    expect(normalizeLocale('zh-TW')).toBe('zh-TW')
    expect(normalizeLocale('zh')).toBe('zh-CN')
    expect(normalizeLocale('fr-FR')).toBe('zh-CN')
    expect(normalizeLocale('')).toBe('zh-CN')
    expect(normalizeLocale(null)).toBe('zh-CN')
  })

  it('falls back exactly like the frozen run locale chain', () => {
    expect(localeFallbackChain('zh-TW')).toEqual(['zh-TW', 'zh-CN'])
    expect(localeFallbackChain('en-US')).toEqual(['en'])
    expect(localeFallbackChain('ja')).toEqual(['ja'])
  })

  it('picks an overlay, treats empty strings as missing, and ends at the baseline', () => {
    expect(pickLocalized(overlays, 'en', 'display_name', '搜索')).toBe('Search')
    // ja's overlay exists but is blank, so the baseline wins instead of rendering nothing.
    expect(pickLocalized(overlays, 'ja', 'display_name', '搜索')).toBe('搜索')
    // en does not borrow zh-CN: no en description means the baseline, not 基础版.
    expect(pickLocalized({ en: { display_name: 'Search' } }, 'en', 'description', '基础版')).toBe('基础版')
    expect(pickLocalized(undefined, 'en', 'display_name', '搜索')).toBe('搜索')
    expect(pickLocalized(overlays, 'ru', 'display_name')).toBeUndefined()
  })

  it('routes zh-TW through zh-CN before the baseline', () => {
    expect(pickLocalized(overlays, 'zh-TW', 'display_name', '搜索')).toBe('搜尋')
    expect(pickLocalized(overlays, 'zh-TW', 'description', '基础版')).toBe('基础版')
    expect(pickLocalized(overlays, 'zh-HK', 'label', '节点')).toBe('检索')
  })

  it('labels a node from overlay, baseline label, then node key', () => {
    expect(pickNodeLabel({ node_key: 'search', label: '检索节点', i18n: overlays }, 'en')).toBe('检索节点')
    expect(pickNodeLabel({ node_key: 'search', label: '检索节点' }, 'en')).toBe('检索节点')
    expect(pickNodeLabel({ node_key: 'search' }, 'en')).toBe('search')
    expect(pickNodeLabel({ node_key: 'search', label: '  ' }, 'en')).toBe('search')
    expect(pickNodeLabel({ node_key: 'search', i18n: overlays }, 'ja')).toBe('search')
  })
})
