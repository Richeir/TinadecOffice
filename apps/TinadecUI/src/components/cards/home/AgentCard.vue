<script setup lang="ts">
import AgentActivityPanel from '@/components/AgentActivityPanel.vue'
import { homeController } from '@/controllers/HomeController'

const c = homeController
</script>

<template>
  <AgentActivityPanel
    :activity="c.agentActivity.value"
    :agent-states="c.agentStatesMap.value"
    :thinking-steps="c.agentThinkingSteps.value"
    :progress-events="c.agentProgressEvents.value"
    :orchestration="c.orchestration.value"
    :feed="c.conversationFeed"
    :runs="c.runs.value"
    :workspace-root="c.currentProject.value?.path ?? null"
  />
</template>
