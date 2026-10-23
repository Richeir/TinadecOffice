<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { reasoningEfforts, type ReasoningEffortChoice } from '@/lib/reasoningEffort'

/**
 * Reasoning effort as a stepless slider: model default, then off → extra high.
 *
 * The face follows Claude Desktop's effort slider: a 26px groove the knob rides IN, one dot per
 * stop, `Faster` / `Smarter` naming the axis, and the level's name in the head. The track moves
 * freely while the pointer is down — positions are fractional stop units — and the choice snaps to
 * the nearest stop on release. `update:modelValue` always carries a whole stop (so callers never
 * store a partial value), while `commit` fires once the choice settles (pointer released, key
 * pressed), so a caller that saves on commit writes once per choice rather than once per pixel.
 *
 * The top stop is the showpiece: the plain fill and dots hand the groove over to a violet field that
 * floods out of the knob towards the left, with a drift of stars travelling through it.
 */
const props = defineProps<{ modelValue: ReasoningEffortChoice; id?: string; disabled?: boolean; label?: string; hint?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: ReasoningEffortChoice]; commit: [value: ReasoningEffortChoice] }>()
const { t } = useI18n()

const stops: readonly ReasoningEffortChoice[] = ['', ...reasoningEfforts]
const last = stops.length - 1
const index = computed(() => Math.max(0, stops.indexOf(props.modelValue)))
/** Position in stop units: fractional between the stops while the pointer owns the knob. */
const position = ref(index.value)
/** True from pointerdown to release: the one state that outranks a value written from outside. */
const pressed = ref(false)
const input = ref<HTMLInputElement | null>(null)

watch(index, value => { if (!pressed.value) position.value = value }, { immediate: true })

const progress = computed(() => last > 0 ? position.value / last : 0)
/** The top stop is the only one that floods: purple field, violet knob, violet name. */
const atMax = computed(() => last > 0 && Math.round(position.value) === last)
const tick = (stop: ReasoningEffortChoice) => t(`settings.reasoningTick.${stop || 'default'}`)
/** Follows the live position, so the name rolls over stop by stop while the knob travels. */
const valueText = computed(() => tick(stops[Math.round(position.value)] ?? ''))

const snap = (value: number) => Math.min(last, Math.max(0, Math.round(value)))

function settleAt(value: number) {
  if (props.disabled) return
  const stopIndex = snap(value)
  const stop = stops[stopIndex] ?? ''
  pressed.value = false
  position.value = stopIndex
  // The bound value is already this integer, so Vue skips the patch: put the thumb on the stop now.
  if (input.value) input.value.value = String(stopIndex)
  emit('update:modelValue', stop)
  emit('commit', stop)
}

function onInput(event: Event) {
  if (props.disabled) return
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  position.value = Math.min(last, Math.max(0, value))
  emit('update:modelValue', stops[snap(value)] ?? '')
}

function onChange(event: Event) { settleAt(Number((event.target as HTMLInputElement).value)) }

/** The native track moves a hundredth of a stop per arrow key; whole stops are what a keypress means. */
function onKeydown(event: KeyboardEvent) {
  if (props.disabled) return
  let target: number
  switch (event.key) {
    case 'ArrowLeft': case 'ArrowDown': case 'PageDown': target = position.value - 1; break
    case 'ArrowRight': case 'ArrowUp': case 'PageUp': target = position.value + 1; break
    case 'Home': target = 0; break
    case 'End': target = last; break
    default: return
  }
  event.preventDefault()
  settleAt(target)
}

/**
 * The starfield, in the top stop's violet: scattered dots of its own size, twinkle and pace, laid
 * over one bar width and then repeated a second time, so a drift of exactly one bar width loops
 * without a seam (the second copy arrives where the first began).
 */
const stars = Array.from({ length: 18 }, (_, i) => {
  const scatter = (n: number) => {
    let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(n + 7, 0x85ebca6b)
    h = Math.imul(h ^ (h >>> 15), 0x2545f491)
    h ^= h >>> 13
    return (h >>> 0) / 4294967296
  }
  const left = scatter(1) * 50
  const top = 3 + scatter(2) * 19
  const size = scatter(3) > 0.74 ? 2 : 1.5
  const halo = scatter(4) > 0.66
  return [0, 50].map(offset => ({
    key: `${i}-${offset}`,
    style: {
      left: `${(left + offset).toFixed(2)}%`,
      top: `${top.toFixed(1)}px`,
      width: `${size}px`,
      height: `${size}px`,
      animationDelay: `-${(scatter(5) * 2.6).toFixed(2)}s`,
      animationDuration: `${(1.7 + scatter(6) * 1.9).toFixed(2)}s`,
      ...(halo ? { boxShadow: '0 0 4px rgba(255, 255, 255, 0.85)' } : {}),
    },
  }))
}).flat()
</script>

<template>
  <div class="reasoning-slider" :data-disabled="disabled || undefined" :data-dragging="pressed || undefined" :data-apex="atMax || undefined" :style="{ '--pos': progress }">
    <div class="reasoning-slider-head">
      <label v-if="label" :for="id" :title="hint" class="reasoning-slider-label">{{ label }}</label>
      <span class="reasoning-slider-value" :key="valueText">{{ valueText }}</span>
    </div>
    <div class="reasoning-slider-ends" aria-hidden="true">
      <span>{{ t('settings.reasoningScale.faster') }}</span>
      <span>{{ t('settings.reasoningScale.smarter') }}</span>
    </div>
    <div class="reasoning-slider-track">
      <span class="reasoning-slider-groove" aria-hidden="true" />
      <span class="reasoning-slider-fill" aria-hidden="true" />
      <span v-if="atMax" class="reasoning-slider-surge" aria-hidden="true">
        <span class="reasoning-slider-veil" />
        <span class="reasoning-slider-stars">
          <span v-for="star in stars" :key="star.key" class="reasoning-slider-star" :style="star.style" />
        </span>
      </span>
      <span class="reasoning-slider-ticks" aria-hidden="true">
        <span v-for="(stop, i) in stops" :key="stop || 'default'" class="reasoning-slider-tick" :style="{ '--at': i / last }" />
      </span>
      <input ref="input" :id="id" class="reasoning-slider-input" type="range" min="0" :max="last" step="0.01" :value="position" :disabled="disabled"
        :aria-label="label" :aria-valuetext="valueText" data-testid="reasoning-slider"
        @pointerdown="pressed = true" @pointerup="pressed = false" @pointercancel="pressed = false"
        @input="onInput" @change="onChange" @keydown="onKeydown" />
    </div>
  </div>
</template>

<style scoped>
.reasoning-slider {
  --thumb-w: 16px;
  --thumb-h: 30px;
  --groove: 26px;
  --corner: 8px;
  /* The un-dragged half of the track is plain grey; the top stop is the only violet in the control. */
  --track: color-mix(in srgb, #9a94a4 34%, transparent);
  --apex: #7c3aed;
  --apex-ink: #b9a6ff;
  display: flex; flex-direction: column; min-width: 0; user-select: none;
}
.reasoning-slider[data-disabled] { opacity: 0.55; }

/* Two groups, not four rows: the name reads as the head, and the axis caption belongs to its track. */
.reasoning-slider-head { display: flex; align-items: baseline; gap: 6px; min-width: 0; margin-bottom: 6px; }
.reasoning-slider-label { flex: none; font-size: 13px; line-height: 16px; font-weight: 500; color: var(--text-secondary); }
/* The level's name carries the weight, the label only names the axis (Claude's `Effort High`). */
.reasoning-slider-value { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 16px;
  font-weight: 600; color: var(--text-primary); transition: color 200ms ease; animation: reasoning-value-in 240ms cubic-bezier(0.2, 0, 0, 1); }
@keyframes reasoning-value-in {
  from { opacity: 0; transform: translateY(3px); filter: blur(2px); }
  to { opacity: 1; transform: none; filter: none; }
}

.reasoning-slider-ends { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 2px; margin-bottom: 4px;
  font-size: 10px; line-height: 12px; color: var(--text-muted); }

/* The hit area is the knob's height; the groove sits centred in it and the knob pokes 2px past it. */
.reasoning-slider-track { position: relative; display: flex; align-items: center; height: var(--thumb-h); }
.reasoning-slider-groove,
.reasoning-slider-surge { position: absolute; left: 0; right: 0; top: 50%; height: var(--groove); margin-top: calc(var(--groove) / -2); border-radius: var(--corner); pointer-events: none; }
.reasoning-slider-groove { background: var(--track); transition: box-shadow 300ms ease; }
.reasoning-slider[data-apex] .reasoning-slider-groove { box-shadow: 0 0 12px color-mix(in srgb, var(--apex) 45%, transparent); }

/* The fill runs to the knob's centre, where the opaque knob swallows it: square right cap, so no
   sliver of bare groove opens up between the fill and the knob. */
.reasoning-slider-fill { position: absolute; left: 0; top: 50%; height: var(--groove); margin-top: calc(var(--groove) / -2);
  width: calc(var(--thumb-w) / 2 + (100% - var(--thumb-w)) * var(--pos)); border-radius: var(--corner) 0 0 var(--corner);
  background: color-mix(in srgb, var(--text-primary) 30%, transparent); pointer-events: none;
  transition: width 220ms cubic-bezier(0.2, 0, 0, 1), opacity 200ms ease; }
.reasoning-slider[data-dragging] .reasoning-slider-fill { transition: none; }

.reasoning-slider-ticks { position: absolute; inset: 0; pointer-events: none; transition: opacity 200ms ease; }
.reasoning-slider-tick { position: absolute; top: 50%; left: calc(var(--thumb-w) / 2 + (100% - var(--thumb-w)) * var(--at)); width: 4px; height: 4px; margin-top: -2px;
  transform: translateX(-50%); border-radius: 50%; background: color-mix(in srgb, var(--text-primary) 26%, transparent); }

/* Top stop: the violet floods OUT OF THE KNOB, leftwards — the clip only opens from the right edge,
   so the field arrives from where the pointer let go. Stars and a slow veil drift through it. */
.reasoning-slider-surge { overflow: hidden; background: linear-gradient(90deg, #4c1d95 0%, #6d3fe0 38%, #8b5cf6 72%, #7c3aed 100%);
  animation: reasoning-surge 640ms cubic-bezier(0.22, 0.61, 0.36, 1) both; }
@keyframes reasoning-surge {
  from { clip-path: inset(0 0 0 100%); }
  to { clip-path: inset(0 0 0 0); }
}
.reasoning-slider-veil { position: absolute; top: 0; bottom: 0; left: 0; width: 200%; pointer-events: none;
  background: linear-gradient(100deg, transparent 0%, rgba(216, 180, 254, 0.3) 42%, rgba(255, 255, 255, 0.45) 50%, rgba(216, 180, 254, 0.3) 58%, transparent 100%);
  background-size: 50% 100%; animation: reasoning-drift 7.5s linear infinite; }
.reasoning-slider-stars { position: absolute; top: 0; bottom: 0; left: 0; width: 200%; pointer-events: none; animation: reasoning-drift 11s linear infinite; }
.reasoning-slider-star { position: absolute; border-radius: 50%; background: #ffffff; opacity: 0.7;
  animation-name: reasoning-twinkle; animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
/* One bar width of travel; the star layer carries the field twice, so the loop has no seam. */
@keyframes reasoning-drift {
  from { transform: translate3d(0, 0, 0); }
  to { transform: translate3d(-50%, 0, 0); }
}
@keyframes reasoning-twinkle {
  0%, 100% { opacity: 0.2; }
  50% { opacity: 0.95; }
}

/* The native track is left clear: the groove, fill, dots and the flooding field are what is seen. */
.reasoning-slider-input { position: relative; z-index: 1; width: 100%; height: var(--thumb-h); min-height: 0; margin: 0; padding: 0; border: 0; background: transparent; box-shadow: none;
  -webkit-appearance: none; appearance: none; cursor: pointer; }
.reasoning-slider-input:disabled { cursor: default; }
.reasoning-slider-input::-webkit-slider-runnable-track { height: var(--thumb-h); border: 0; background: transparent; }
/* A vertical capsule, not a bead: 16px wide, 30px tall, poking 2px past the groove top and bottom.
   Pinned to white in both themes — it is the one light pebble in the groove. */
.reasoning-slider-input::-webkit-slider-thumb { -webkit-appearance: none; width: var(--thumb-w); height: var(--thumb-h); margin: 0; border: 0; border-radius: 5px;
  background: #ffffff; box-shadow: 0 1px 3px rgba(20, 20, 19, 0.28), 0 0 0 1px rgba(20, 20, 19, 0.06);
  transition: transform 140ms cubic-bezier(0.2, 0, 0, 1), box-shadow 220ms ease, background-color 220ms ease; }
.reasoning-slider-input:not(:disabled):hover::-webkit-slider-thumb { transform: scale(1.06); }
.reasoning-slider[data-dragging] .reasoning-slider-input::-webkit-slider-thumb { transform: scale(1.1); }
.reasoning-slider-input:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; border-radius: 10px; }
.reasoning-slider-input:focus-visible::-webkit-slider-thumb { box-shadow: 0 1px 3px rgba(20, 20, 19, 0.28), 0 0 0 1px var(--accent-primary); }

/* Top stop: the plain fill and the dots stand down for the field, the knob takes the violet. */
.reasoning-slider[data-apex] .reasoning-slider-fill,
.reasoning-slider[data-apex] .reasoning-slider-ticks { opacity: 0; }
.reasoning-slider[data-apex] .reasoning-slider-input::-webkit-slider-thumb { background: color-mix(in srgb, var(--apex) 12%, #ffffff);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.55), 0 0 12px color-mix(in srgb, var(--apex) 85%, transparent), 0 1px 3px rgba(12, 8, 20, 0.45); }
.reasoning-slider[data-apex] .reasoning-slider-value { color: var(--apex-ink); }

:root[data-theme='light'] .reasoning-slider { --track: color-mix(in srgb, #6f6a7a 18%, transparent); --apex: #6d28d9; --apex-ink: #6d28d9; }
:root[data-theme='light'] .reasoning-slider-input::-webkit-slider-thumb { box-shadow: 0 1px 3px rgba(20, 20, 19, 0.22), 0 0 0 1px rgba(20, 20, 19, 0.1); }

@media (prefers-reduced-motion: reduce) {
  .reasoning-slider-fill,
  .reasoning-slider-value,
  .reasoning-slider-groove,
  .reasoning-slider-input::-webkit-slider-thumb { transition: none; }
  .reasoning-slider-surge,
  .reasoning-slider-veil,
  .reasoning-slider-stars,
  .reasoning-slider-star,
  .reasoning-slider-value { animation: none; }
  .reasoning-slider-star { opacity: 0.85; }
}
</style>
