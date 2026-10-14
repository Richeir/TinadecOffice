import { ref } from 'vue'

/**
 * The code font: one CSS variable, `--font-mono`, behind every monospace surface (code blocks,
 * commands, paths, diffs, terminals). The app used to name 'Geist Mono' without bundling it, so
 * monospace fell back to the platform's generic font — on Chinese Windows that is NSimSun, whose
 * embedded bitmaps read as a pixel font.
 *
 * Four open fonts (OFL) are bundled; Consolas and the system font are offered as system choices
 * and fall back to JetBrains Mono where they are missing. CJK text inside code falls to a CJK
 * UI font before the generic `monospace`, never to NSimSun.
 */
export interface CodeFont {
  id: string
  label: string
  family: string
  /** Shipped with the app; system fonts depend on the platform. */
  bundled: boolean
}

export const CODE_FONTS: readonly CodeFont[] = [
  { id: 'jetbrains-mono', label: 'JetBrains Mono', family: "'JetBrains Mono Variable'", bundled: true },
  { id: 'geist-mono', label: 'Geist Mono', family: "'Geist Mono Variable'", bundled: true },
  { id: 'fira-code', label: 'Fira Code', family: "'Fira Code Variable'", bundled: true },
  { id: 'cascadia-code', label: 'Cascadia Code', family: "'Cascadia Code Variable'", bundled: true },
  { id: 'consolas', label: 'Consolas', family: 'Consolas', bundled: false },
  { id: 'system', label: 'system', family: "ui-monospace, 'SF Mono', Menlo, 'Cascadia Mono'", bundled: false },
]

export const DEFAULT_CODE_FONT = 'jetbrains-mono'
const STORAGE_KEY = 'tinadec-code-font'
const CJK_FALLBACK = "'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', 'Noto Sans CJK SC', 'Source Han Sans SC'"

/** The full stack for a choice: the font, JetBrains Mono where it is missing, CJK, generic. */
export function codeFontStack(id: string): string {
  const font = CODE_FONTS.find(item => item.id === id) ?? CODE_FONTS[0]!
  const fallback = font.id === DEFAULT_CODE_FONT ? '' : ", 'JetBrains Mono Variable'"
  return `${font.family}${fallback}, ${CJK_FALLBACK}, monospace`
}

function readStored(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored && CODE_FONTS.some(font => font.id === stored) ? stored : DEFAULT_CODE_FONT
  } catch { return DEFAULT_CODE_FONT }
}

export const codeFont = ref(readStored())

function apply() {
  document.documentElement.style.setProperty('--font-mono', codeFontStack(codeFont.value))
}

export function setCodeFont(id: string): void {
  if (!CODE_FONTS.some(font => font.id === id)) return
  codeFont.value = id
  try { localStorage.setItem(STORAGE_KEY, id) } catch { /* the choice still applies to this window */ }
  apply()
}

/** Applies the stored choice and follows changes made in other windows. Call once per window. */
export function installCodeFont(): void {
  apply()
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return
    codeFont.value = readStored()
    apply()
  })
}
