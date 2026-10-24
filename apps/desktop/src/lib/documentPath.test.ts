import { describe, expect, it } from 'vitest'
import {
  documentBaseName,
  documentExtension,
  documentParentDir,
  isMarkdownPath,
  isTextLikePath,
  normalizeWorkspacePath,
  parseDocumentRef,
} from './documentPath'

describe('parseDocumentRef', () => {
  it('recognises a workspace path and its line suffixes', () => {
    expect(parseDocumentRef('docs/spec.md')).toEqual({ path: 'docs/spec.md' })
    expect(parseDocumentRef('src/api.ts:120')).toEqual({ path: 'src/api.ts', line: 120 })
    expect(parseDocumentRef('src/api.ts:120:7')).toEqual({ path: 'src/api.ts', line: 120 })
    expect(parseDocumentRef('docs/spec.md#L42')).toEqual({ path: 'docs/spec.md', line: 42 })
    expect(parseDocumentRef('docs/spec.md#L42-L80')).toEqual({ path: 'docs/spec.md', line: 42 })
    expect(parseDocumentRef('./docs/spec.md')).toEqual({ path: 'docs/spec.md' })
    expect(parseDocumentRef('`docs/spec.md`')).toEqual({ path: 'docs/spec.md' })
  })

  it('rejects URLs, host:port pairs, timestamps and prose', () => {
    expect(parseDocumentRef('https://example.invalid/a.md')).toBeNull()
    expect(parseDocumentRef('http://localhost/a.md')).toBeNull()
    expect(parseDocumentRef('mailto:team@example.invalid')).toBeNull()
    expect(parseDocumentRef('file:///tmp/a.md')).toBeNull()
    expect(parseDocumentRef('node:fs')).toBeNull()
    // A port and a clock are the two shapes that look like `path:line`.
    expect(parseDocumentRef('localhost:8080')).toBeNull()
    expect(parseDocumentRef('10:30')).toBeNull()
    expect(parseDocumentRef('v1.2:3')).toBeNull()
    // Code and commands are not paths.
    expect(parseDocumentRef('pnpm build')).toBeNull()
    expect(parseDocumentRef('useUie()')).toBeNull()
    expect(parseDocumentRef('--force')).toBeNull()
    expect(parseDocumentRef('@scope/pkg')).toBeNull()
    expect(parseDocumentRef('main')).toBeNull()
    expect(parseDocumentRef('')).toBeNull()
  })

  it('rejects a line number of zero, a bare directory and a too-long extension', () => {
    expect(parseDocumentRef('a.md:0')).toBeNull()
    expect(parseDocumentRef('src/main')).toBeNull()
    expect(parseDocumentRef('docs/notes.unknownext')).toBeNull()
    // A short unknown extension still resolves; the workspace check decides existence.
    expect(parseDocumentRef('docs/notes.xyz')).toEqual({ path: 'docs/notes.xyz' })
  })

  it('normalises Windows separators and drive letters into a reference path', () => {
    expect(parseDocumentRef('C:\\git\\repo\\a.ts')).toEqual({ path: 'C:/git/repo/a.ts' })
    expect(parseDocumentRef('docs\\guide.md:12')).toEqual({ path: 'docs/guide.md', line: 12 })
  })
})

describe('normalizeWorkspacePath', () => {
  it('returns a workspace-relative path for relative and in-root absolute input', () => {
    expect(normalizeWorkspacePath('/w', 'docs/a.md')).toBe('docs/a.md')
    expect(normalizeWorkspacePath('/w', './docs/a.md')).toBe('docs/a.md')
    expect(normalizeWorkspacePath('/w', 'docs/../a.md')).toBe('a.md')
    expect(normalizeWorkspacePath('/w', '/w/docs/a.md')).toBe('docs/a.md')
    expect(normalizeWorkspacePath('/w/', 'docs/a.md')).toBe('docs/a.md')
  })

  it('refuses escapes, the root itself and an empty workspace', () => {
    expect(normalizeWorkspacePath('/w', '../a.md')).toBeNull()
    expect(normalizeWorkspacePath('/w', 'docs/../../a.md')).toBeNull()
    expect(normalizeWorkspacePath('/w', '/other/a.md')).toBeNull()
    expect(normalizeWorkspacePath('/w', '/w')).toBeNull()
    expect(normalizeWorkspacePath('/w', '')).toBeNull()
    expect(normalizeWorkspacePath('', 'a.md')).toBeNull()
  })

  it('matches a Windows root regardless of drive-letter case', () => {
    expect(normalizeWorkspacePath('C:\\w', 'C:\\w\\src\\a.ts')).toBe('src/a.ts')
    expect(normalizeWorkspacePath('C:\\w', 'c:/w/src/a.ts')).toBe('src/a.ts')
    expect(normalizeWorkspacePath('C:\\w', 'D:\\w\\src\\a.ts')).toBeNull()
  })
})

describe('path helpers', () => {
  it('splits names, extensions and parents consistently', () => {
    expect(documentBaseName('a/b/c.md')).toBe('c.md')
    expect(documentBaseName('c.md')).toBe('c.md')
    expect(documentExtension('a/b/c.MD')).toBe('md')
    expect(documentExtension('Makefile')).toBe('')
    expect(documentParentDir('a/b/c.md')).toBe('a/b')
    expect(documentParentDir('c.md')).toBe('')
  })

  it('separates markdown, other text and binary documents', () => {
    expect(isMarkdownPath('docs/a.mdx')).toBe(true)
    expect(isMarkdownPath('docs/a.md')).toBe(true)
    expect(isMarkdownPath('src/a.ts')).toBe(false)
    expect(isTextLikePath('src/a.ts')).toBe(true)
    expect(isTextLikePath('logs/run.log')).toBe(true)
    expect(isTextLikePath('assets/shot.png')).toBe(false)
  })
})
