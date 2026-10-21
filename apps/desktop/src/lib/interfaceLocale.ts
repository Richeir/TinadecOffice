import i18n from '@/i18n'
import { normalizeLocale } from '@/lib/packI18n'

/**
 * The language the window is rendered in, sent with an interaction so Core can freeze it onto
 * the run (prompt overlays and response language follow the UI that submitted the request).
 */
export function interfaceLocale(): string {
  return normalizeLocale(i18n.global.locale.value)
}
