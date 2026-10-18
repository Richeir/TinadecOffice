export type SupervisionDecisionOption = 'continue' | 'correct' | 'cancel'

export interface SupervisionReviewBrief {
  totalTasks: number
  completedTasks: number
  blockedTasks: number
  failedTasks: number
  pendingTasks: number
  unmetCriteria: number
  revisionRound: number
  maxRevisionRounds: number
  supervisorRequired: boolean
  supervisorAvailable: boolean
}

export interface SupervisionReview {
  runId: string
  reasons: string[]
  options: SupervisionDecisionOption[]
  brief?: SupervisionReviewBrief | null
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function readSupervisionReviewBrief(value: unknown): SupervisionReviewBrief | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const brief = value as Record<string, unknown>
  return {
    totalTasks: count(brief.total_tasks),
    completedTasks: count(brief.completed_tasks),
    blockedTasks: count(brief.blocked_tasks),
    failedTasks: count(brief.failed_tasks),
    pendingTasks: count(brief.pending_tasks),
    unmetCriteria: count(brief.unmet_criteria),
    revisionRound: count(brief.revision_round),
    maxRevisionRounds: count(brief.max_revision_rounds),
    supervisorRequired: brief.supervisor_required === true,
    supervisorAvailable: brief.supervisor_available === true,
  }
}
