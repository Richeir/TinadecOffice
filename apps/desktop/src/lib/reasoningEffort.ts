import type { ModelParametersDto, ModelProviderInstanceDto } from '@/api'

/**
 * Reasoning effort as a model's saved parameter (`model_parameters[model].reasoning_effort`).
 * '' is "the model's own default": nothing is sent and the provider decides.
 */
export const reasoningEfforts = ['none', 'low', 'medium', 'high', 'xhigh'] as const
export type ReasoningEffort = typeof reasoningEfforts[number]
export type ReasoningEffortChoice = ReasoningEffort | ''

/** Core accepts the parameter only on the OpenAI Chat and Responses protocols. */
export function supportsReasoningEffort(protocol?: string | null): boolean {
  return ['openai-chat', 'openai-responses'].includes(protocol ?? 'openai-chat')
}

/** The provider's parameters with this model's effort set (or cleared), siblings untouched. */
export function withReasoningEffort(provider: ModelProviderInstanceDto, model: string, effort: ReasoningEffortChoice) {
  const parameters: Record<string, ModelParametersDto> = { ...provider.model_parameters }
  const settings: ModelParametersDto = { ...parameters[model] }
  if (effort) settings.reasoning_effort = effort
  else delete settings.reasoning_effort
  if (Object.values(settings).some(value => value != null)) parameters[model] = settings
  else delete parameters[model]
  return parameters
}
