<script setup lang="ts">
import { CircleCheck, CircleDashed, CircleDot, CircleSlash, CircleX, Hourglass, Loader } from '@lucide/vue'
import { computed, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SessionDto } from '@/api'
import type { ActivityFacts, ActivityTone } from '@/lib/recentActivity'

/**
 * One activity card: the conversation on top, then the run's state on the left and the facts
 * (duration, workspace) on the right. 最近活动, 所有活动 and 项目活动 all draw this same card, so the
 * tone vocabulary and its colours live here instead of being copied per block.
 */
const props = defineProps<{
  session: SessionDto
  projectName: string
  facts: ActivityFacts
  /** False inside a project group: the group header already names the workspace. */
  showWorkspace?: boolean
  active?: boolean
}>()
const emit = defineEmits<{ select: []; menu: [event: MouseEvent] }>()
const { t } = useI18n()
const icons: Record<ActivityTone, Component> = {
  awaiting: Hourglass,
  active: Loader,
  completed: CircleCheck,
  failed: CircleX,
  cancelled: CircleSlash,
  unknown: CircleDot,
  idle: CircleDashed,
}
const label = computed(() => {
  switch (props.facts.tone) {
    case 'awaiting': return t('sidebar.activityState.awaiting')
    case 'active': return t('sidebar.activityState.active')
    case 'completed': return t('sidebar.activityState.completed')
    case 'failed': return t('sidebar.activityState.failed')
    case 'cancelled': return t('sidebar.activityState.cancelled')
    case 'unknown': return t('sidebar.activityState.unknown')
    default: return t('sidebar.activityState.idle')
  }
})
const title = computed(() => props.showWorkspace === false
  ? props.session.title
  : `${props.session.title} · ${props.projectName}`)
</script>

<template>
  <button
    type="button"
    class="activity-card"
    :class="{ active }"
    :title="title"
    @click="emit('select')"
    @contextmenu.prevent="emit('menu', $event)"
  >
    <span class="activity-title">{{ session.title }}</span>
    <span class="activity-meta">
      <span class="activity-state" :class="`activity-state--${facts.tone}`">
        <component :is="icons[facts.tone]" :size="12" class="activity-state-icon" />
        <span class="activity-state-label">{{ label }}</span>
      </span>
      <span class="activity-facts">
        <span class="activity-duration">{{ facts.measure }}</span>
        <span v-if="showWorkspace !== false" class="activity-workspace">{{ projectName }}</span>
      </span>
    </span>
  </button>
</template>
