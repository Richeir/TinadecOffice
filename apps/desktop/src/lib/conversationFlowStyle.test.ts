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
 * The five steps of the density ladder are one setting: every consumer reads
 * `conversationFlowRules`, so this file is the only place that has to know a step is a bag of rules.
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
  it('offers five steps, ordered from the emptiest feed to the fullest', () => {
    expect(CONVERSATION_FLOW_PRESETS.map((entry) => entry.preset)).toEqual([
      'minimal',
      'concise',
      'balanced',
      'detailed',
      'rich',
    ])
  })

  it('only concise keeps a row budget, and it keeps seven', () => {
    const budgeted = CONVERSATION_FLOW_PRESETS.filter((entry) => entry.rules.settled === 'budget')
    expect(budgeted.map((entry) => entry.preset)).toEqual(['concise'])
    expect(budgeted[0]!.rules.budget).toBe(7)
  })

  it('minimal is the only step that hides settled work, and balanced the only one that lists quiet steps', () => {
    expect(CONVERSATION_FLOW_PRESETS.filter((entry) => entry.rules.settled === 'hidden').map((entry) => entry.preset)).toEqual(['minimal'])
    expect(CONVERSATION_FLOW_PRESETS.filter((entry) => entry.rules.quiet === 'listed').map((entry) => entry.preset)).toEqual(['balanced'])
  })

  it('a sub-agent opens in place only in the fuller steps, and only rich opens it while it runs', () => {
    expect(CONVERSATION_FLOW_PRESETS.filter((entry) => entry.rules.subAgentDetail === 'inline').map((entry) => entry.preset)).toEqual(['detailed', 'rich'])
    expect(CONVERSATION_FLOW_PRESETS.filter((entry) => entry.rules.subAgentOpen === 'running').map((entry) => entry.preset)).toEqual(['rich'])
  })

  it('says more about a sub-agent the fuller the step is', () => {
    const level = (preset: (typeof CONVERSATION_FLOW_PRESETS)[number]['preset']) =>
      CONVERSATION_FLOW_PRESETS.find((entry) => entry.preset === preset)!.rules.subAgent
    expect(level('minimal')).toBe('name')
    expect(level('concise')).toBe('task')
    expect(level('rich')).toBe('result')
  })
})

describe('the stored preset', () => {
  it('starts at the fullest step, not at storage', () => {
    expect(DEFAULT_CONVERSATION_FLOW_PRESET).toBe('rich')
    expect(conversationFlowPreset.value).toBe('rich')
    expect(conversationFlowRules.value.settled).toBe('all')
  })

  it('writes the choice and exposes its rules', () => {
    setConversationFlowPreset('minimal')
    expect(localStorage.getItem(CONVERSATION_FLOW_KEY)).toBe('minimal')
    expect(conversationFlowPreset.value).toBe('minimal')
    expect(conversationFlowRules.value).toMatchObject({ settled: 'hidden', quiet: 'grouped' })
  })

  it('treats an unknown or missing value as the default, never as a crash', () => {
    // No migration table: a value this build does not know lands on the default step, the one
    // whose description the reader can see in Settings.
    localStorage.setItem(CONVERSATION_FLOW_KEY, 'not-a-step')
    expect(isConversationFlowPreset(localStorage.getItem(CONVERSATION_FLOW_KEY))).toBe(false)
    expect(isConversationFlowPreset(undefined)).toBe(false)
    expect(isConversationFlowPreset('rich')).toBe(true)
  })

  it('follows a change made in another window', () => {
    localStorage.setItem(CONVERSATION_FLOW_KEY, 'detailed')
    window.dispatchEvent(new StorageEvent('storage', { key: CONVERSATION_FLOW_KEY }))
    expect(conversationFlowPreset.value).toBe('detailed')
  })

  it('ignores a storage event for an unrelated key', () => {
    setConversationFlowPreset('balanced')
    localStorage.setItem('tinadec.enter_pref', 'parallel')
    window.dispatchEvent(new StorageEvent('storage', { key: 'tinadec.enter_pref' }))
    expect(conversationFlowPreset.value).toBe('balanced')
  })
})
