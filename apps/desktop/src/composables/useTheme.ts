import { useStorage } from '@vueuse/core'
import { ref, watch, type Ref } from 'vue'
import {
  argbFromHex,
  buildDynamicVars,
  DYNAMIC_VAR_NAMES,
  isValidHexColor,
  type DynamicVars,
} from '../lib/monetExtract'
import { getDynamicPaletteRef } from './useDynamicPalette'

export type Theme = 'dark' | 'light' | 'system'

/** Pseudo accent key: colors derived from the image background (Monet). */
export const DYNAMIC_ACCENT_KEY = 'dynamic'

/** Pseudo accent key: colors derived from the user's own picked hex. */
export const CUSTOM_ACCENT_KEY = 'custom'

/** Seed used when `custom` is selected before a color was ever picked. */
const CUSTOM_ACCENT_FALLBACK = '#d2bdf5'

/**
 * The shipped default. This is the "poster lilac" the brand moved to; the CSS
 * floor in styles.css carries the same two hex values so the app looks the
 * same whether or not the Monet injection has run.
 */
export const DEFAULT_ACCENT = 'purple'

/**
 * Builds before the lilac switch persisted the old default (`blue`) into
 * localStorage the first time they booted, so changing the constant alone
 * would leave every existing install on blue. The marker makes this a
 * one-shot migration: anyone who deliberately picks blue afterwards keeps it.
 */
const ACCENT_MIGRATION_KEY = 'tinadec-accent-migrated-lilac'
const LEGACY_DEFAULT_ACCENT = 'blue'

export interface AccentColor {
  key: string
  labelKey: string
  dark: {
    accentPrimary: string
    accentBrand: string
    textBrand: string
    borderInputFocus: string
    shadowFocus: string
  }
  light: {
    accentPrimary: string
    accentBrand: string
    textBrand: string
    borderInputFocus: string
    shadowFocus: string
  }
}

export const ACCENT_COLORS: AccentColor[] = [
  {
    key: 'blue',
    labelKey: 'accentColors.blue',
    dark: {
      accentPrimary: '#58a6ff',
      accentBrand: '#58a6ff',
      textBrand: '#58a6ff',
      borderInputFocus: '#58a6ff',
      shadowFocus: '0 0 0 3px rgba(88, 166, 255, 0.3)',
    },
    light: {
      accentPrimary: '#0969da',
      accentBrand: '#1f6feb',
      textBrand: '#0969da',
      borderInputFocus: '#0969da',
      shadowFocus: '0 0 0 3px rgba(9, 105, 218, 0.14)',
    },
  },
  {
    key: 'green',
    labelKey: 'accentColors.green',
    dark: {
      accentPrimary: '#3fb950',
      accentBrand: '#3fb950',
      textBrand: '#3fb950',
      borderInputFocus: '#3fb950',
      shadowFocus: '0 0 0 3px rgba(63, 185, 80, 0.3)',
    },
    light: {
      accentPrimary: '#1a7f37',
      accentBrand: '#1a7f37',
      textBrand: '#1a7f37',
      borderInputFocus: '#1a7f37',
      shadowFocus: '0 0 0 3px rgba(26, 127, 55, 0.14)',
    },
  },
  {
    key: 'purple',
    labelKey: 'accentColors.purple',
    dark: {
      accentPrimary: '#d2bdf5',
      accentBrand: '#d2bdf5',
      textBrand: '#d2bdf5',
      borderInputFocus: '#d2bdf5',
      shadowFocus: '0 0 0 3px rgba(210, 189, 245, 0.3)',
    },
    light: {
      accentPrimary: '#675687',
      accentBrand: '#675687',
      textBrand: '#675687',
      borderInputFocus: '#675687',
      shadowFocus: '0 0 0 3px rgba(103, 86, 135, 0.14)',
    },
  },
  {
    key: 'orange',
    labelKey: 'accentColors.orange',
    dark: {
      accentPrimary: '#f0883e',
      accentBrand: '#f0883e',
      textBrand: '#f0883e',
      borderInputFocus: '#f0883e',
      shadowFocus: '0 0 0 3px rgba(240, 136, 62, 0.3)',
    },
    light: {
      accentPrimary: '#bc4c00',
      accentBrand: '#bc4c00',
      textBrand: '#953800',
      borderInputFocus: '#bc4c00',
      shadowFocus: '0 0 0 3px rgba(188, 76, 0, 0.14)',
    },
  },
  {
    key: 'pink',
    labelKey: 'accentColors.pink',
    dark: {
      accentPrimary: '#f778ba',
      accentBrand: '#f778ba',
      textBrand: '#f778ba',
      borderInputFocus: '#f778ba',
      shadowFocus: '0 0 0 3px rgba(247, 120, 186, 0.3)',
    },
    light: {
      accentPrimary: '#bf3989',
      accentBrand: '#bf3989',
      textBrand: '#953074',
      borderInputFocus: '#bf3989',
      shadowFocus: '0 0 0 3px rgba(191, 57, 137, 0.14)',
    },
  },
  {
    key: 'red',
    labelKey: 'accentColors.red',
    dark: {
      accentPrimary: '#f85149',
      accentBrand: '#f85149',
      textBrand: '#f85149',
      borderInputFocus: '#f85149',
      shadowFocus: '0 0 0 3px rgba(248, 81, 73, 0.3)',
    },
    light: {
      accentPrimary: '#cf222e',
      accentBrand: '#cf222e',
      textBrand: '#a40e26',
      borderInputFocus: '#cf222e',
      shadowFocus: '0 0 0 3px rgba(207, 34, 46, 0.14)',
    },
  },
  {
    key: 'cyan',
    labelKey: 'accentColors.cyan',
    dark: {
      accentPrimary: '#56d4dd',
      accentBrand: '#56d4dd',
      textBrand: '#56d4dd',
      borderInputFocus: '#56d4dd',
      shadowFocus: '0 0 0 3px rgba(86, 212, 221, 0.3)',
    },
    light: {
      accentPrimary: '#087990',
      accentBrand: '#087990',
      textBrand: '#065975',
      borderInputFocus: '#087990',
      shadowFocus: '0 0 0 3px rgba(8, 121, 144, 0.14)',
    },
  },
  {
    key: 'yellow',
    labelKey: 'accentColors.yellow',
    dark: {
      accentPrimary: '#d29922',
      accentBrand: '#d29922',
      textBrand: '#d29922',
      borderInputFocus: '#d29922',
      shadowFocus: '0 0 0 3px rgba(210, 153, 34, 0.3)',
    },
    light: {
      accentPrimary: '#9a6700',
      accentBrand: '#9a6700',
      textBrand: '#7c5200',
      borderInputFocus: '#9a6700',
      shadowFocus: '0 0 0 3px rgba(154, 103, 0, 0.14)',
    },
  },
]

// 使用 ref 延迟初始化，避免在模块加载时访问 localStorage
let stored: Ref<Theme> | null = null
let storedAccentColor: Ref<string> | null = null
let storedCustomAccent: Ref<string> | null = null

function getStoredTheme(): Ref<Theme> {
  if (!stored) {
    stored = useStorage<Theme>('tinadec-theme', 'dark')
  }
  return stored
}

function getStoredAccentColor(): Ref<string> {
  if (!storedAccentColor) {
    const ref0 = useStorage<string>('tinadec-accent-color', DEFAULT_ACCENT)
    try {
      if (!localStorage.getItem(ACCENT_MIGRATION_KEY)) {
        localStorage.setItem(ACCENT_MIGRATION_KEY, '1')
        // Only the value the old build wrote for us is migrated — a user who
        // picked a colour of their own (custom / dynamic / green…) is left alone.
        if (ref0.value === LEGACY_DEFAULT_ACCENT) ref0.value = DEFAULT_ACCENT
      }
    } catch {
      // Private mode / storage disabled: the stored value still wins.
    }
    storedAccentColor = ref0
  }
  return storedAccentColor
}

/** The user's own accent hex; only consulted when the key is `custom`. */
export function getCustomAccentHex(): Ref<string> {
  if (!storedCustomAccent) {
    const ref0 = useStorage<string>('tinadec-custom-accent', CUSTOM_ACCENT_FALLBACK)
    if (!isValidHexColor(ref0.value)) ref0.value = CUSTOM_ACCENT_FALLBACK
    storedCustomAccent = ref0
  }
  return storedCustomAccent
}

/**
 * Test-only: drop the module-level storage singletons so each case re-reads
 * localStorage. Without this, the first `useTheme()` in a file pins the refs
 * and later cases observe the previous case's values.
 */
export function __resetThemeForTests(): void {
  stored = null
  storedAccentColor = null
  storedCustomAccent = null
}

/**
 * Unified color pipeline: every accent — 8 presets and the extracted
 * wallpaper color alike — seeds the same Monet tonal builder and injects
 * the same full-surface token set. One parameter, one code path.
 */
const PRESET_SEEDS: Record<string, number> = Object.fromEntries(
  ACCENT_COLORS.map((c) => [c.key, argbFromHex(c.dark.accentPrimary)]),
)
const FALLBACK_SEED = PRESET_SEEDS.blue!

/** Presets are pure functions of (seed, theme) — build each combo once. */
const presetVarsCache = new Map<string, DynamicVars>()

function resolveAccentVars(key: string, theme: 'dark' | 'light'): DynamicVars | null {
  if (key === DYNAMIC_ACCENT_KEY) {
    // Not memoized: a fresh extraction must take effect immediately.
    // Before the first extraction lands (no wallpaper, or still booting) the
    // pipeline falls back to the default brand seed. Returning null here used
    // to leave every surface at the raw CSS values, which is how a user could
    // end up staring at a palette nobody picked.
    const sourceColor = getDynamicPaletteRef().value?.sourceColor
    const seed = typeof sourceColor === 'number' ? sourceColor >>> 0 : FALLBACK_SEED
    return buildDynamicVars(seed, theme)
  }
  if (key === CUSTOM_ACCENT_KEY) {
    // Not memoized: the seed changes every time the user moves a slider.
    return buildDynamicVars(argbFromHex(getCustomAccentHex().value), theme)
  }
  const cacheKey = `${key}:${theme}`
  let vars = presetVarsCache.get(cacheKey)
  if (!vars) {
    vars = buildDynamicVars(PRESET_SEEDS[key] ?? FALLBACK_SEED, theme)
    presetVarsCache.set(cacheKey, vars)
  }
  return vars
}

function applyTheme(theme: Theme) {
  let resolved: 'dark' | 'light'
  if (theme === 'system') {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } else {
    resolved = theme
  }
  document.documentElement.setAttribute('data-theme', resolved)
}

function applyAccentColor(colorKey: string) {
  const resolved = document.documentElement.getAttribute('data-theme') as 'dark' | 'light' ?? 'dark'
  const root = document.documentElement

  removeDynamicVars(root)
  const vars = resolveAccentVars(colorKey, resolved)
  if (!vars) return
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value)
  }
}

function removeDynamicVars(root: HTMLElement) {
  for (const name of DYNAMIC_VAR_NAMES) {
    root.style.removeProperty(name)
  }
}

export function useTheme() {
  const themeRef = getStoredTheme()
  const accentColorRef = getStoredAccentColor()
  const customAccentRef = getCustomAccentHex()

  function applyInitialTheme() {
    applyTheme(themeRef.value)
    applyAccentColor(accentColorRef.value)
  }

  // 立即应用主题
  applyInitialTheme()

  watch(themeRef, (val) => {
    applyTheme(val)
    applyAccentColor(accentColorRef.value)
  })

  watch(accentColorRef, (val) => {
    applyAccentColor(val)
  })

  // Re-apply when a new extraction lands while "follow background" is on.
  watch(getDynamicPaletteRef(), () => {
    if (accentColorRef.value === DYNAMIC_ACCENT_KEY) {
      applyAccentColor(DYNAMIC_ACCENT_KEY)
    }
  })

  // Re-apply when the custom hex changes while "custom" is on.
  watch(customAccentRef, () => {
    if (accentColorRef.value === CUSTOM_ACCENT_KEY) {
      applyAccentColor(CUSTOM_ACCENT_KEY)
    }
  })

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeRef.value === 'system') {
      applyTheme('system')
      applyAccentColor(accentColorRef.value)
    }
  })

  return {
    theme: themeRef,
    setTheme: (t: Theme) => {
      themeRef.value = t
    },
    accentColor: accentColorRef,
    setAccentColor: (key: string) => {
      accentColorRef.value = key
    },
    /** The custom hex ref — bind the picker to it and previews stay live. */
    customAccent: customAccentRef,
    setCustomAccent: (hex: string) => {
      if (isValidHexColor(hex)) customAccentRef.value = hex.toLowerCase()
    },
    accentColors: ACCENT_COLORS,
    applyInitialTheme,
  }
}
