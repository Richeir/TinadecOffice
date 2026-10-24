/**
 * highlight.js setup shared by the conversation renderer and the document reader.
 *
 * It lives here rather than inside MarkdownRender so both surfaces register the same
 * 20 languages once and share one cache; a second import of `highlight.js/lib/core`
 * from another module would otherwise re-register the same grammars and grow a
 * second cache that streams a reply twice.
 */
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import plaintext from 'highlight.js/lib/languages/plaintext'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const languageModules: Array<[string, unknown]> = [
  ['bash', bash],
  ['cpp', cpp],
  ['csharp', csharp],
  ['css', css],
  ['diff', diff],
  ['dockerfile', dockerfile],
  ['go', go],
  ['ini', ini],
  ['java', java],
  ['javascript', javascript],
  ['json', json],
  ['markdown', markdown],
  ['plaintext', plaintext],
  ['powershell', powershell],
  ['python', python],
  ['rust', rust],
  ['sql', sql],
  ['typescript', typescript],
  ['xml', xml],
  ['yaml', yaml],
]

for (const [name, definition] of languageModules) hljs.registerLanguage(name, definition as never)

/**
 * A reply is re-parsed on every streaming delta, so the same code block would be
 * highlighted again and again. The cache keeps that off the hot path; it is
 * cleared wholesale at the cap because a reply is not worth LRU bookkeeping.
 */
const highlightCache = new Map<string, string>()
const HIGHLIGHT_CACHE_LIMIT = 240

/** Fence aliases highlight.js knows under another name. */
const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  py: 'python',
  rs: 'rust',
  yml: 'yaml',
  cs: 'csharp',
  'c++': 'cpp',
  htm: 'xml',
  html: 'xml',
  vue: 'xml',
  md: 'markdown',
  text: 'plaintext',
  txt: 'plaintext',
  ps1: 'powershell',
}

/** Resolve a fence label or file extension to a registered grammar, if any. */
export function resolveHighlightLanguage(language: string | null | undefined): string | null {
  const key = (language ?? '').trim().toLowerCase()
  if (!key) return null
  const alias = LANGUAGE_ALIASES[key] ?? key
  return hljs.getLanguage(alias) ? alias : null
}

/**
 * `getLanguage` probes the alias table without logging; `highlight` warns and
 * throws on an unknown alias, so a fence like ```foobar degrades quietly.
 */
export function highlightCode(code: string, language: string | null): string {
  const languageKey = resolveHighlightLanguage(language)
  const cacheKey = `${languageKey ?? ''}\u0000${code}`
  const cached = highlightCache.get(cacheKey)
  if (cached !== undefined) return cached
  let value: string
  try {
    value = hljs.highlight(code, { language: languageKey ?? 'plaintext', ignoreIllegals: true }).value
  } catch {
    value = hljs.highlight(code, { language: 'plaintext', ignoreIllegals: true }).value
  }
  if (highlightCache.size >= HIGHLIGHT_CACHE_LIMIT) highlightCache.clear()
  highlightCache.set(cacheKey, value)
  return value
}
