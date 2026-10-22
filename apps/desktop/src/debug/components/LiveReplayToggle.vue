<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const mode = ref<'live' | 'replay'>('live')
</script>

<template>
  <div class="live-replay-toggle">
    <button
      class="toggle-btn"
      :class="{ active: mode === 'live' }"
      @click="mode = 'live'"
    >{{ t('debugStudio.liveMode') }}</button>
    <button
      class="toggle-btn"
      :class="{ active: mode === 'replay' }"
      @click="mode = 'replay'"
    >{{ t('debugStudio.replayMode') }}</button>
  </div>
</template>

<style scoped>
.live-replay-toggle {
  display: flex;
  background: #21262d;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid #30363d;
}
.toggle-btn {
  background: none;
  border: none;
  color: #8b949e;
  padding: 3px 12px;
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
  letter-spacing: 0.5px;
  transition: background 0.12s, color 0.12s;
}
.toggle-btn:hover { color: #eadef7; }
.toggle-btn.active {
  background: #30363d;
  color: #e6edf3;
}
.toggle-btn:first-child.active { color: #3fb950; }
</style>
