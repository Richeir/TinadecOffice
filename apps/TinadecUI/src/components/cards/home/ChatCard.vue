<script setup lang="ts">
import ChatPanel from '@/components/ChatPanel.vue'
import { computed } from 'vue'
import { homeController } from '@/controllers/HomeController'

const c = homeController

// `busy` means "the send is still on its way", not "a run is working". A run's progress is the
// transcript's job (live work rows, answer drafting); folding `working` in here made the send
// button spin and announce "sending" for the entire run, so the moment Core accepted the
// message was indistinguishable from the moment the answer arrived. Stopping a run reads
// `canStop`, which spans the run as it should.
//
// Supervision escalations reach the flat feed through its own reducer (they are run state
// there), so this card no longer rebuilds them from the activity store. That map only ever
// held runs the activity composable had last selected, which is why an escalation on any
// other run had no visible gate. Space mode still reads the composable directly.
const conversation = computed(() => ({
  feed: c.conversationFeed,
  runs: c.runs.value,
  streamingReplies: c.streamingReplies.value,
  approvals: c.approvals.value,
  workspaceRoot: c.currentProject.value?.path ?? null,
}))
</script>

<template>
  <ChatPanel
    :messages="c.messages.value"
    :sessions="c.sessions.value"
    :projects="c.projects.value"
    :current-session="c.currentSession.value"
    :current-project="c.currentProject.value"
    :selected-project-id="c.selectedProjectId.value"
    :model-name="c.modelName.value"
    :orchestration="c.orchestration.value"
    :busy="c.busy.value"
    :draft="c.draft.value"
    :permission="c.currentPermission.value"
    :composer-settings="c.composerSettings.value"
    :settings-saving="c.settingsSaving.value"
    :settings-error="c.settingsError.value"
    :runs-for-composer="c.runs.value"
    :can-stop="Boolean(c.stoppableRunId.value)"
    :conversation="conversation"
    :loading="c.transcriptLoading.value"
    @update:draft="c.updateDraft($event)"
    @update:permission="c.updatePermission($event)"
    @update:settings="c.updateComposerSettings($event)"
    @send="c.sendMessage($event)"
    @welcome-send="c.handleWelcomeSend($event)"
    @create-project="c.openProject()"
    @select-project="c.setSelectedProject($event)"
    @edit-message="c.editAndResend($event)"
    @stop="c.stopRun()"
  />
</template>
