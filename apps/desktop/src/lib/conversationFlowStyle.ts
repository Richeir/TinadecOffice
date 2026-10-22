import { computed, ref, type ComputedRef } from 'vue'

/**
 * How much of a run's work the flat conversation shows, as one choice on a five-step ladder
 * from minimal to rich.
 *
 * The steps are density, not provenance: each one is a value of `ConversationFlowRules`, and
 * every consumer (grouping, the turn fold, the sub-agent row) reads the rules and never the
 * step's name, so adding a sixth step is one entry here.
 */
export type ConversationFlowPreset = 'minimal' | 'concise' | 'balanced' | 'detailed' | 'rich'

export interface ConversationFlowRules {
  /** What is left of a settled turn's work: nothing, the last `budget` nodes, or all of it. */
  settled: 'hidden' | 'budget' | 'all'
  /** Nodes kept when `settled === 'budget'`. Sub-agent rows, plans and failures never count. */
  budget: number
  /** Consecutive quiet steps (thoughts, reads, searches, listings, waits) as one line or one each. */
  quiet: 'grouped' | 'listed'
  /** How much of a sub-agent its row says. */
  subAgent: 'name' | 'task' | 'result'
  /** Where a sub-agent's own activity lives: its row, or the right-column card only. */
  subAgentDetail: 'panel' | 'inline'
  /** Whether a running sub-agent opens itself. */
  subAgentOpen: 'manual' | 'running'
}

export interface ConversationFlowPresetDefinition {
  preset: ConversationFlowPreset
  rules: ConversationFlowRules
}

/**
 * Ordered from the emptiest feed to the fullest. `concise` is the only step that keeps a row
 * budget: it folds the earliest rows into one "earlier" line and keeps the latest seven, which
 * is the answer to "everything is too long" that `rich` does not have.
 */
export const CONVERSATION_FLOW_PRESETS: readonly ConversationFlowPresetDefinition[] = [
  {
    preset: 'minimal',
    rules: { settled: 'hidden', budget: 0, quiet: 'grouped', subAgent: 'name', subAgentDetail: 'panel', subAgentOpen: 'manual' },
  },
  {
    preset: 'concise',
    rules: { settled: 'budget', budget: 7, quiet: 'grouped', subAgent: 'task', subAgentDetail: 'panel', subAgentOpen: 'manual' },
  },
  {
    preset: 'balanced',
    rules: { settled: 'all', budget: 0, quiet: 'listed', subAgent: 'task', subAgentDetail: 'panel', subAgentOpen: 'manual' },
  },
  {
    preset: 'detailed',
    rules: { settled: 'all', budget: 0, quiet: 'grouped', subAgent: 'result', subAgentDetail: 'inline', subAgentOpen: 'manual' },
  },
  {
    preset: 'rich',
    rules: { settled: 'all', budget: 0, quiet: 'grouped', subAgent: 'result', subAgentDetail: 'inline', subAgentOpen: 'running' },
  },
]

export const CONVERSATION_FLOW_KEY = 'tinadec.conversation-flow-preset'

/** The fullest step: everything stays, and a running sub-agent shows its work unasked. */
export const DEFAULT_CONVERSATION_FLOW_PRESET: ConversationFlowPreset = 'rich'

const PRESET_NAMES = new Set<string>(CONVERSATION_FLOW_PRESETS.map((entry) => entry.preset))

export function isConversationFlowPreset(value: unknown): value is ConversationFlowPreset {
  return typeof value === 'string' && PRESET_NAMES.has(value)
}

export function rulesForPreset(preset: ConversationFlowPreset): ConversationFlowRules {
  return (CONVERSATION_FLOW_PRESETS.find((entry) => entry.preset === preset) ?? CONVERSATION_FLOW_PRESETS[0]!).rules
}

/**
 * Values written before the steps were named by density are not mapped: an unknown value falls
 * back to the default rather than to a guessed neighbour, so a reader lands on a step whose
 * description is on screen instead of on one that silently behaves like another.
 */
function readStored(): ConversationFlowPreset {
  if (typeof localStorage === 'undefined') return DEFAULT_CONVERSATION_FLOW_PRESET
  const stored = localStorage.getItem(CONVERSATION_FLOW_KEY)
  return isConversationFlowPreset(stored) ? stored : DEFAULT_CONVERSATION_FLOW_PRESET
}

const preset = ref<ConversationFlowPreset>(readStored())

/** Another window picked a step; the reader's own choice still wins in this one. */
function followStored(event: StorageEvent): void {
  if (event.key !== null && event.key !== CONVERSATION_FLOW_KEY) return
  preset.value = readStored()
}

if (typeof window !== 'undefined') window.addEventListener('storage', followStored)

export const conversationFlowPreset: ComputedRef<ConversationFlowPreset> = computed(() => preset.value)

/**
 * The active rules. Consumers take this as a parameter instead of reading the preset, so a
 * pure function (grouping) stays testable with any shape.
 */
export const conversationFlowRules: ComputedRef<ConversationFlowRules> = computed(() => rulesForPreset(preset.value))

export function setConversationFlowPreset(next: ConversationFlowPreset): void {
  preset.value = next
  try {
    localStorage.setItem(CONVERSATION_FLOW_KEY, next)
  } catch {
    // A full or blocked store must not swallow the choice for this window.
  }
}

/** For tests: back to the default preset without writing storage. */
export function resetConversationFlowStyleForTests(): void {
  preset.value = DEFAULT_CONVERSATION_FLOW_PRESET
}
