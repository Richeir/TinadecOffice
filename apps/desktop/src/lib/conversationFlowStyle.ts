import { computed, ref, type ComputedRef } from 'vue'

/**
 * How much of a run's work the flat conversation shows, as one choice of five.
 *
 * The presets are named after the transcript shapes they copy, because "detailed" alone
 * does not tell a reader whether reads are one line each or folded into one. Each preset is
 * a value of `ConversationFlowRules`; every consumer (grouping, the turn fold, the sub-agent
 * row) reads the rules and never the preset name, so adding a sixth shape is one entry here.
 */
export type ConversationFlowPreset = 'codex' | 'claude' | 'openchamber' | 'trae' | 'qoder'

/** The word shown next to a preset's name. */
export type ConversationFlowDensity = 'compact' | 'detailed' | 'rich'

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
  density: ConversationFlowDensity
  rules: ConversationFlowRules
}

/**
 * Ordered from quietest to fullest. `openchamber` is the only shape that keeps a row
 * budget: its transcript folds the earliest rows into one "earlier" line and keeps the
 * latest seven, which is the answer to "everything is too long" that Qoder does not have.
 */
export const CONVERSATION_FLOW_PRESETS: readonly ConversationFlowPresetDefinition[] = [
  {
    preset: 'codex',
    density: 'compact',
    rules: { settled: 'hidden', budget: 0, quiet: 'grouped', subAgent: 'name', subAgentDetail: 'panel', subAgentOpen: 'manual' },
  },
  {
    preset: 'claude',
    density: 'detailed',
    rules: { settled: 'all', budget: 0, quiet: 'listed', subAgent: 'task', subAgentDetail: 'panel', subAgentOpen: 'manual' },
  },
  {
    preset: 'openchamber',
    density: 'detailed',
    rules: { settled: 'budget', budget: 7, quiet: 'grouped', subAgent: 'task', subAgentDetail: 'panel', subAgentOpen: 'manual' },
  },
  {
    preset: 'trae',
    density: 'rich',
    rules: { settled: 'all', budget: 0, quiet: 'grouped', subAgent: 'result', subAgentDetail: 'inline', subAgentOpen: 'manual' },
  },
  {
    preset: 'qoder',
    density: 'rich',
    rules: { settled: 'all', budget: 0, quiet: 'grouped', subAgent: 'result', subAgentDetail: 'inline', subAgentOpen: 'running' },
  },
]

export const CONVERSATION_FLOW_KEY = 'tinadec.conversation-flow-preset'

/** The shape borrowed from the reference the flat feed was modelled on. */
export const DEFAULT_CONVERSATION_FLOW_PRESET: ConversationFlowPreset = 'qoder'

const PRESET_NAMES = new Set<string>(CONVERSATION_FLOW_PRESETS.map((entry) => entry.preset))

export function isConversationFlowPreset(value: unknown): value is ConversationFlowPreset {
  return typeof value === 'string' && PRESET_NAMES.has(value)
}

export function rulesForPreset(preset: ConversationFlowPreset): ConversationFlowRules {
  return (CONVERSATION_FLOW_PRESETS.find((entry) => entry.preset === preset) ?? CONVERSATION_FLOW_PRESETS[0]!).rules
}

function readStored(): ConversationFlowPreset {
  if (typeof localStorage === 'undefined') return DEFAULT_CONVERSATION_FLOW_PRESET
  const stored = localStorage.getItem(CONVERSATION_FLOW_KEY)
  return isConversationFlowPreset(stored) ? stored : DEFAULT_CONVERSATION_FLOW_PRESET
}

const preset = ref<ConversationFlowPreset>(readStored())

/** Another window picked a preset; the reader's own choice still wins in this one. */
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
