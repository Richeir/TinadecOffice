/**
 * The one i18n instance. Interface text lives only in locales/{zh-CN,zh-TW,en,ja,ru}.ts, which all carry
 * the same keys (locales/i18nParity.test.ts): components use useI18n(), module code i18n.global.t, pure
 * helpers take a `Translate`; dates and numbers format with the active locale.
 *
 * Only the default locale is imported statically. The other four bundles are 0.6–0.9 MB of source each:
 * importing all five at boot put every one of them into the renderer entry chunk for a window that can
 * show one. They arrive through `loadLocale()` — the language picker awaits it before switching, and a
 * window that starts in a saved non-default locale asks for its bundle at startup.
 *
 * Two invariants hold while a bundle is still loading:
 *  - every supported locale is registered from the start (each with its own `common.languageName`), so
 *    `availableLocales` stays complete and each language is named in itself in the picker;
 *  - `t()` still answers: a key the target bundle does not have yet falls back to en and then zh-CN
 *    (always loaded), so an unfinished load never renders a raw key or throws.
 */
import { createI18n } from 'vue-i18n'
import zhCN from './locales/zh-CN'

/** The interface languages, in the order the language picker lists them. */
export const SUPPORTED_LOCALES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ru'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

// 延迟获取 localStorage，避免在模块加载时访问；存了不认识的值就回到默认语言
function getSavedLocale(): SupportedLocale {
  if (typeof window !== 'undefined' && window.localStorage) {
    const saved = localStorage.getItem('tinadec-locale')
    if (isSupportedLocale(saved)) return saved
  }
  return 'zh-CN'
}

/**
 * Russian has three plural forms, written `one | few | many`: 1, 21, 31… / 2–4, 22–24… / everything
 * else (0, 5–20, 25…). A message with fewer forms uses its last one.
 */
export function russianPluralRule(choice: number, choicesLength: number): number {
  const n = Math.abs(choice)
  const lastDigit = n % 10
  const lastTwo = n % 100
  const form = lastDigit === 1 && lastTwo !== 11 ? 0
    : lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 10 || lastTwo >= 20) ? 1
    : 2
  return Math.min(form, choicesLength - 1)
}

/**
 * Each language is named in itself. These five strings are the only interface text kept outside
 * locales/*.ts on purpose: the picker lists all five languages at once, so every name must exist before
 * any non-default bundle has been fetched.
 */
const SELF_NAMES: Record<SupportedLocale, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ru: 'Русский',
}
const selfNameSeed = (locale: SupportedLocale) => ({ common: { languageName: SELF_NAMES[locale] } })

/** The shape of one locale bundle, as the lazily imported modules export it. */
type Bundle = typeof zhCN

/** The default locale ships in the entry chunk; the other four are separate chunks. */
const STARTING_LOCALE = getSavedLocale()

const LOADERS = {
  'zh-TW': () => import('./locales/zh-TW'),
  en: () => import('./locales/en'),
  ja: () => import('./locales/ja'),
  ru: () => import('./locales/ru'),
} satisfies Record<Exclude<SupportedLocale, 'zh-CN'>, () => Promise<{ default: Bundle }>>

// The message schema is inferred from zh-CN because it is the only bundle in the entry chunk. Casting
// it to a loose Record instead makes every message path unknown and degrades `locale` itself to a plain
// string, which then breaks `i18n.global.locale.value` for every caller in the app.
const i18n = createI18n({
  legacy: false,
  locale: STARTING_LOCALE,
  // A Traditional Chinese reader is better served by Simplified than by English, and zh-CN is the one
  // bundle that is always present, so it is also the last resort while another bundle is being fetched.
  fallbackLocale: { 'zh-TW': ['zh-CN', 'en'], default: ['en', 'zh-CN'] },
  pluralRules: { ru: russianPluralRule },
  messages: {
    'zh-CN': zhCN,
    'zh-TW': selfNameSeed('zh-TW'),
    en: selfNameSeed('en'),
    ja: selfNameSeed('ja'),
    ru: selfNameSeed('ru'),
  },
})

/** Locales whose full bundle is registered. zh-CN is eager, so it starts here. */
const registered = new Set<SupportedLocale>(['zh-CN'])
const inFlight = new Map<SupportedLocale, Promise<void>>()

/**
 * Fetch and register one interface language. Idempotent and single-flight: concurrent callers share one
 * import and a loaded locale resolves immediately. Rejects when the chunk cannot be fetched (after
 * logging) so a caller keeps the current language instead of switching to a half-loaded one; a later
 * call retries.
 */
export function loadLocale(locale: SupportedLocale): Promise<void> {
  if (locale === 'zh-CN') return Promise.resolve()
  if (registered.has(locale)) return Promise.resolve()
  const running = inFlight.get(locale)
  if (running) return running
  const task = LOADERS[locale as Exclude<SupportedLocale, 'zh-CN'>]()
    .then((module) => {
      i18n.global.setLocaleMessage(locale, module.default)
      registered.add(locale)
    })
    .catch((error: unknown) => {
      console.error(`[i18n] could not load '${locale}'; the interface stays in ${i18n.global.locale.value}`, error)
      throw error
    })
    .finally(() => { inFlight.delete(locale) })
  inFlight.set(locale, task)
  return task
}

/** Resolves once the locale the window is displaying has its bundle. */
export function ensureActiveLocale(): Promise<void> {
  return loadLocale(i18n.global.locale.value)
}

/**
 * The one way to change the interface language: fetch the bundle, then switch. Both entry points call
 * this (the language picker and the cross-window announcement in main.ts), so neither can repaint into
 * a language whose bundle has not arrived. Resolves to false when the chunk could not be loaded — the
 * active language is then untouched and the caller keeps whatever it was showing.
 */
export async function setInterfaceLocale(locale: SupportedLocale): Promise<boolean> {
  try {
    await loadLocale(locale)
  } catch {
    return false
  }
  i18n.global.locale.value = locale
  return true
}

// A window that starts in a saved non-default language asks for that bundle right away. The awaited
// callers (picker, cross-window switch) share this import, so nothing is fetched twice.
if (STARTING_LOCALE !== 'zh-CN') void loadLocale(STARTING_LOCALE).catch(() => {})

/**
 * The forms of useI18n()'s `t` that plain helpers take from their caller, so their wording
 * follows the component's language without the helper importing this instance.
 */
export interface Translate {
  (key: string): string
  (key: string, named: Record<string, unknown>): string
  (key: string, named: Record<string, unknown>, plural: number): string
}

export default i18n
