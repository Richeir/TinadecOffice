<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import AgentPetAvatar from '@/components/pets/AgentPetAvatar.vue'
import { instanceKeyOf } from '@/lib/avatarAssignment'
import type { SubAgentNode } from '@/lib/conversation/grouping'
import SubAgentCard from './SubAgentCard.vue'

/**
 * Consecutive dispatches as one group: "2 agents working…" while two or more run, then one
 * compact card per sub-agent, in dispatch order.
 *
 * The group head carries the faces of the agents that are actually working, so a parallel turn
 * shows who is on it before the eye reaches the individual cards. Four is the most that fits
 * next to the label; the cards below still list every agent.
 */
const props = defineProps<{ agents: SubAgentNode[]; runId: string; workspaceRoot?: string | null }>()
const { t } = useI18n()

function isWorking(agent: SubAgentNode): boolean {
  return agent.status === 'running' || agent.status === 'awaiting_approval'
}

const working = computed(() => props.agents.filter(isWorking).length)
const workingFaces = computed(() => props.agents.filter(isWorking).slice(0, 4).map((agent) => ({
  key: instanceKeyOf(props.runId, agent.agent.taskId),
  agentId: agent.agent.agentSlug,
})))
</script>

<template>
  <div class="conversation-agent-group" data-testid="agent-group">
    <p v-if="working >= 2" class="conversation-agent-group-head" data-testid="agent-group-head">
      <span class="conversation-agent-group-faces" aria-hidden="true">
        <AgentPetAvatar
          v-for="face in workingFaces"
          :key="face.key"
          :instance-key="face.key"
          :agent-id="face.agentId"
          :size="16"
        />
      </span>
      <span class="shimmer">{{ t('conversation.agents.working', { count: working }, working) }}</span>
    </p>
    <SubAgentCard v-for="agent in agents" :key="agent.agent.taskId" :node="agent" :run-id="runId" :workspace-root="workspaceRoot" />
  </div>
</template>

<style scoped>
.conversation-agent-group { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.conversation-agent-group-head { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12px; color: var(--text-secondary); }
.conversation-agent-group-faces { display: inline-flex; flex: none; align-items: center; gap: 2px; }
</style>
