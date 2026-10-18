import type { SseChunk } from '@/generated/client'
import { runStreamDelta } from './runStream'

/** The answer text a client has accumulated for one run's live stream. */
export type RunReply = string

/**
 * Folds one run-stream chunk into the accumulated answer text.
 *
 * Core publishes an answer under a single kind, `answer.delta`, whether it arrived frame by
 * frame from the meeting model or whole from a path that answered without a model (an evidence
 * fallback or a status query). There is no second, authoritative whole-text frame to replace a
 * provisional preview with, so this is a plain append: `answer.started` begins a fresh answer
 * (a retry discards the withdrawn one), and anything else that is not an increment is ignored.
 */
export function projectRunReply(previous: RunReply, chunk: SseChunk): RunReply | null {
  if (chunk.kind === 'answer.started' || chunk.kind === 'answer.failed') return ''
  if (chunk.kind !== 'answer.delta') return null
  return previous + runStreamDelta(chunk)
}
