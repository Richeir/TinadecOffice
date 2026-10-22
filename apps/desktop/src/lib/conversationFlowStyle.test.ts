// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CONVERSATION_FLOW_KEY,
  CONVERSATION_FLOW_PRESETS,
  DEFAULT_CONVERSATION_FLOW_PRESET,
  conversationFlowPreset,
  conversationFlowRules,
  isConversationFlowPreset,
  resetConversationFlowStyleForTests,
  setConversationFlowPreset,
} from './conversationFlowStyle'

/**
 * The five transcript shapes are one setting: every consumer reads `conversationFlowRules`,
 * so this file is the only place that has to know a preset is a bag of rules.
 */
beforeEach(() => {
  localStorage.clear()
  resetConversationFlowStyleForTests()
})
afterEach(() => {
  localStorage.clear()
  resetConversationFlowStyleForTests()
})

describe('conversation flow presets', () => {
  it('offers five shapes, ordered from quietest to fullest', () => {
    expect(CONVERSATION_FLOW_PRESETS.map((entry) => entry.preset)).toEqual(['codex', 'claude', 'openchamber', 'trae', 'qoder'])
    expect(CONVERSATION_FLOW_PRESETS.map((entry) => entry.density)).toEqual(['compact', 'detailed', 'detailed', 'rich', 'rich'])
  })

  it('only openchamber keeps a row budget, and it keeps seven', () => {
    const budgeted = CONVERSATION_FLOW_PRESETS.filter((entry) => entry.rules.settled === 'budget')
    expect(budgeted.map((entry) => entry.preset)).toEqual(['openchamber'])
    expect(budgeted[0]!.rules.budget).toBe(7)
  })

  it('codex is the only shape that hides settled work, and it is the only one without rows', () => {
    expect(CONVERSATION_FLOW_PRESETS.filter((entry) => entry.rules.settled === 'hidden').map((entry) => entry.preset)).toEqual(['codex'])
    expect(CONVERSATION_FLOW_PRESETS.filter((entry) => entry.rules.quiet === 'listed').map((entry) => entry.preset)).toEqual(['claude'])
  })

  it('a sub-agent can be opened in place only in the rich shapes, and only qoder opens it while it runs', () => {
    expect(CONVERSATION_FLOW_PRESETS.filter((entry) => entry.rules.subAgentDetail === 'inline').map((entry) => entry.preset)).toEqual(['trae', 'qoder'])
    expect(CONVERSATION_FLOW_PRESETS.filter((entry) => entry.rules.subAgentOpen === 'running').map((entry) => entry.preset)).toEqual(['qoder'])
  })

  it('says more about a sub-agent the fuller the shape is', () => {
    const level = (preset: (typeof CONVERSATION_FLOW_PRESETS)[number]['preset']) =>
      CONVERSATION_FLOW_PRESETS.find((entry) => entry.preset === preset)!.rules.subAgent
    expect(level('codex')).toBe('name')
    expect(level('openchamber')).toBe('task')
    expect(level('qoder')).toBe('result')
  })
})

describe('the stored preset', () => {
  it('starts at the shape the feed was modelled on, not at storage', () => {
    expect(DEFAULT_CONVERSATION_FLOW_PRESET).toBe('qoder')
    expect(conversationFlowPreset.value).toBe('qoder')
    expect(conversationFlowRules.value.settled).toBe('all')
  })

  it('writes the choice and exposes its rules', () => {
    setConversationFlowPreset('codex')
    expect(localStorage.getItem(CONVERSATION_FLOW_KEY)).toBe('codex')
    expect(conversationFlowPreset.value).toBe('codex')
    expect(conversationFlowRules.value).toMatchObject({ settled: 'hidden', quiet: 'grouped' })
  })

  it('treats an unknown or missing value as the default, never as a crash', () => {
    localStorage.setItem(CONVERSATION_FLOW_KEY, 'not-a-preset')
    expect(isConversationFlowPreset(localStorage.getItem(CONVERSATION_FLOW_KEY))).toBe(false)
    // The ref was read at import time; re-reading is what a reload does.
    expect(isConversationFlowPreset(undefined)).toBe(false)
    expect(isConversationFlowPreset('qoder')).toBe(true)
  })

  it('follows a change made in another window', () => {
    localStorage.setItem(CONVERSATION_FLOW_KEY, 'trae')
    window.dispatchEvent(new StorageEvent('storage', { key: CONVERSATION_FLOW_KEY }))
    expect(conversationFlowPreset.value).toBe('trae')
  })

  it('ignores a storage event for an unrelated key', () => {
    setConversationFlowPreset('claude')
    localStorage.setItem('tinadec.enter_pref', 'parallel')
    window.dispatchEvent(new StorageEvent('storage', { key: 'tinadec.enter_pref' }))
    expect(conversationFlowPreset.value).toBe('claude')
  })
})
