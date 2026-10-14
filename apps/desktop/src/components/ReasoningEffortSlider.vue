<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { reasoningEfforts, type ReasoningEffortChoice } from '@/lib/reasoningEffort'

/**
 * Reasoning effort as a stepped slider: model default, then off → extra high. `update:modelValue`
 * follows the thumb; `commit` fires once the choice settles (pointer released, key pressed), so a
 * caller that saves on commit writes once per choice, not once per step dragged past.
 */
const props = defineProps<{ modelValue: ReasoningEffortChoice; id?: string; disabled?: boolean; label?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: ReasoningEffortChoice]; commit: [value: ReasoningEffortChoice] }>()
const { t } = useI18n()

const stops: readonly ReasoningEffortChoice[] = ['', ...reasoningEfforts]
const index = computed(() => Math.max(0, stops.indexOf(props.modelValue)))
const fill = computed(() => `${(index.value / (stops.length - 1)) * 100}%`)
const tick = (stop: ReasoningEffortChoice) => t(`settings.reasoningTick.${stop || 'default'}`)
const valueText = computed(() => props.modelValue ? tick(props.modelValue) : t('settings.modelDefaultParameter'))

function at(event: Event) { return stops[Number((event.target as HTMLInputElement).value)] ?? '' }
function choose(stop: ReasoningEffortChoice) {
  if (props.disabled) return
  emit('update:modelValue', stop)
  emit('commit', stop)
}
</script>

<template>
  <div class="reasoning-slider" :data-disabled="disabled || undefined">
    <input :id="id" class="reasoning-slider-input" type="range" min="0" :max="stops.length - 1" step="1" :value="index" :disabled="disabled"
      :aria-label="label" :aria-valuetext="valueText" :style="{ '--reasoning-fill': fill }"
      data-testid="reasoning-slider" @input="emit('update:modelValue', at($event))" @change="emit('commit', at($event))" />
    <div class="reasoning-slider-ticks" aria-hidden="true">
      <span v-for="(stop, i) in stops" :key="stop || 'default'" class="reasoning-slider-tick" :class="{ 'is-active': i === index }"
        :style="{ '--reasoning-at': i / (stops.length - 1) }" @click="choose(stop)">{{ tick(stop) }}</span>
    </div>
  </div>
</template>

<style scoped>
.reasoning-slider { --thumb: 14px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.reasoning-slider[data-disabled] { opacity: 0.55; }
.reasoning-slider-input { width: 100%; height: 4px; margin: 6px 0 0; padding: 0; border: 0; box-shadow: none; min-height: 0; -webkit-appearance: none; appearance: none; border-radius: 2px; outline: none; cursor: pointer;
  background: linear-gradient(to right, var(--accent-primary) var(--reasoning-fill), var(--surface-raised) var(--reasoning-fill)); }
.reasoning-slider-input:disabled { cursor: default; }
.reasoning-slider-input::-webkit-slider-thumb { -webkit-appearance: none; width: var(--thumb); height: var(--thumb); border-radius: 50%; background: var(--accent-primary); box-shadow: 0 0 0 3px var(--surface-section); transition: transform 0.1s; }
.reasoning-slider-input:not(:disabled)::-webkit-slider-thumb:hover { transform: scale(1.15); }
.reasoning-slider-input:focus-visible::-webkit-slider-thumb { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
.reasoning-slider-ticks { position: relative; height: 16px; font-size: 11px; color: var(--text-muted); }
/* Each label is centred under its stop (the thumb's centre runs half a thumb in from either end); the end labels stay inside the track. */
.reasoning-slider-tick { position: absolute; left: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--reasoning-at)); transform: translateX(-50%); white-space: nowrap; cursor: pointer; user-select: none; }
.reasoning-slider-tick:first-child { left: 0; transform: none; }
.reasoning-slider-tick:last-child { left: auto; right: 0; transform: none; }
.reasoning-slider[data-disabled] .reasoning-slider-tick { cursor: default; }
.reasoning-slider-tick.is-active { color: var(--text-primary); font-weight: 600; }
</style>
