<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { SessionDto } from '../api'

/**
 * The active session's title. It used to carry one pill per non-terminal run — the
 * conversation's only "planning / executing / waiting" readout outside the feed. That
 * was a second status vocabulary for the same runs the feed already describes (the work
 * fold's live status line, the plan node, the supervision gate), and it sat outside the
 * transcript where a reader looks. Status now lives in the flow; this header is a title.
 */
defineProps<{
  currentSession: SessionDto | null
}>()

const { t } = useI18n()
</script>

<template>
  <div class="conversation-head">
    <h1>{{ currentSession?.title ?? t('chat.title') }}</h1>
  </div>
</template>
