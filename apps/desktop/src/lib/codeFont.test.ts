// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { CODE_FONTS, codeFont, codeFontStack, installCodeFont, setCodeFont } from './codeFont'

describe('code font', () => {
  /**
   * The bug: monospace fell back to the platform generic, NSimSun on Chinese Windows, which
   * renders as a pixel font. Every stack puts CJK UI fonts before the generic, and a system
   * choice that may be missing (Consolas off Windows) falls back to the bundled JetBrains Mono.
   */
  it('never leaves CJK text or a missing system font to the generic monospace', () => {
    for (const font of CODE_FONTS) {
      const stack = codeFontStack(font.id)
      expect(stack.indexOf("'Microsoft YaHei UI'"), font.id).toBeLessThan(stack.lastIndexOf('monospace'))
      expect(stack.trim().endsWith('monospace'), font.id).toBe(true)
      if (!font.bundled) expect(stack, font.id).toContain("'JetBrains Mono Variable'")
    }
  })

  it('applies the choice to --font-mono, keeps it, and follows another window', () => {
    installCodeFont()
    setCodeFont('fira-code')
    expect(document.documentElement.style.getPropertyValue('--font-mono')).toBe(codeFontStack('fira-code'))
    expect(localStorage.getItem('tinadec-code-font')).toBe('fira-code')
    localStorage.setItem('tinadec-code-font', 'consolas')
    window.dispatchEvent(new StorageEvent('storage', { key: 'tinadec-code-font' }))
    expect(codeFont.value).toBe('consolas')
    expect(document.documentElement.style.getPropertyValue('--font-mono')).toBe(codeFontStack('consolas'))
  })
})
