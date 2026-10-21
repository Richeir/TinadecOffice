import type { PackI18n } from '@/api'
import { SUPPORTED_LOCALES, type SupportedLocale } from '@/i18n'

/**
 * Resolves the per-locale overlays a pack ships on its resources. The fallback chain mirrors
 * Core's `RunLocaleResolver`: exact locale, then zh-TW → zh-CN, then the baseline field. Other
 * locales do not borrow zh-CN — an English reader of a pack with only Chinese overlays sees the
 * baseline the pack author wrote, not a Simplified Chinese overlay.
 *
 * An empty or whitespace-only overlay is treated as missing so a partial translation cannot
 * blank out a name that the baseline still carries.
 */
export type PackI18nField = 'display_name' | 'description' | 'label' | 'system_prompt'

/** Core's normalization: exact match, zh-* → zh-CN/zh-TW, language-only, then the default. */
export function normalizeLocale(locale: string | null | undefined): SupportedLocale {
  const trimmed = (locale ?? '').trim()
  if (!trimmed) return 'zh-CN'
  const exact = SUPPORTED_LOCALES.find((item) => item.toLowerCase() === trimmed.toLowerCase())
  if (exact) return exact
  if (trimmed.toLowerCase().startsWith('zh')) {
    const upper = trimmed.toUpperCase()
    return upper.includes('TW') || upper.includes('HK') ? 'zh-TW' : 'zh-CN'
  }
  const language = trimmed.split('-')[0]!.toLowerCase()
  return SUPPORTED_LOCALES.find((item) => item.toLowerCase() === language) ?? 'zh-CN'
}

export function localeFallbackChain(locale: string | null | undefined): readonly SupportedLocale[] {
  const normalized = normalizeLocale(locale)
  return normalized === 'zh-TW' ? ['zh-TW', 'zh-CN'] : [normalized]
}

export function pickLocalized(
  i18n: PackI18n | null | undefined,
  locale: string | null | undefined,
  field: PackI18nField,
  base?: string | null,
): string | undefined {
  for (const candidate of localeFallbackChain(locale)) {
    const value = i18n?.[candidate]?.[field]
    if (typeof value === 'string' && value.trim()) return value
  }
  return base?.trim() ? base : undefined
}

/** A mode node's displayed label: localized label, baseline label, then its stable node key. */
export function pickNodeLabel(
  node: { label?: string | null; node_key?: string | null; i18n?: PackI18n | null },
  locale: string | null | undefined,
): string {
  return pickLocalized(node.i18n, locale, 'label', node.label) ?? node.node_key ?? ''
}
