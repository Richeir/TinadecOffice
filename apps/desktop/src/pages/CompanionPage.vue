<script setup lang="ts">
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

// The main process owns the window's shape; this page only renders what it reports and sends
// gestures. Never flip `expanded` locally — a stale local copy would disagree with the real
// bounds after a blur collapse or a display change.
const { t } = useI18n()
const state = ref<CompanionState | null>(null)
const dragging = ref(false)
const expanded = computed(() => state.value?.expanded === true)
const side = computed<'left' | 'right'>(() => state.value?.side ?? 'right')

const SWIPE_EXPAND_PX = 26
const AXIS_LOCK_PX = 4
const CLICK_SUPPRESS_MS = 350

interface DragStart {
  pointerId: number
  pointerX: number
  pointerY: number
  windowTop: number
  axis: 'x' | 'y' | null
}

let capsuleDrag: DragStart | null = null
let panelDrag: DragStart | null = null
let suppressClickUntil = 0
let disposeState: (() => void) | undefined

function applyState(next: CompanionState | null | undefined): void {
  if (next) state.value = next
}

function command(action: () => Promise<CompanionState>, label: string): void {
  action()
    .then(applyState)
    .catch((error) => console.warn(`[companion] ${label} failed:`, error))
}

function expand(): void {
  command(() => window.tinadec.companion.expand(), 'expand')
}

function collapse(): void {
  command(() => window.tinadec.companion.collapse(), 'collapse')
}

function dock(next: 'left' | 'right'): void {
  if (side.value === next) return
  command(() => window.tinadec.companion.setSide(next), 'setSide')
}

function trackPointer(event: PointerEvent, windowTop: number, axis: DragStart['axis']): DragStart {
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  dragging.value = true
  return {
    pointerId: event.pointerId,
    pointerX: event.screenX,
    pointerY: event.screenY,
    windowTop,
    axis,
  }
}

// The capsule is the whole 24px-wide window, so a vertical drag has to survive the window moving
// under the pointer (pointer capture) and a horizontal drag must not nudge the dock height (axis
// lock). Inward travel is measured from the capture point, not from the window, because by then
// the window may have moved.
function beginCapsuleDrag(event: PointerEvent): void {
  if (event.button !== 0) return
  capsuleDrag = trackPointer(event, window.screenY, null)
}

function moveCapsuleDrag(event: PointerEvent): void {
  const drag = capsuleDrag
  if (!drag || drag.pointerId !== event.pointerId) return
  const dx = event.screenX - drag.pointerX
  const dy = event.screenY - drag.pointerY
  if (!drag.axis) {
    if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return
    drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
  }
  if (drag.axis === 'y') {
    window.tinadec.companion.moveTo(drag.windowTop + dy).catch((error) => {
      console.warn('[companion] moveTo failed:', error)
    })
  }
}

function endCapsuleDrag(event: PointerEvent): void {
  const drag = capsuleDrag
  if (!drag || drag.pointerId !== event.pointerId) return
  capsuleDrag = null
  dragging.value = false
  if (!drag.axis) return
  // A drag that ends on the button still produces a click; that click is not a request to open.
  suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS
  if (drag.axis !== 'x') return
  const inward = side.value === 'left' ? event.screenX - drag.pointerX : drag.pointerX - event.screenX
  if (inward >= SWIPE_EXPAND_PX) expand()
}

function onCapsuleClick(event: MouseEvent): void {
  // Keyboard activation reports detail 0 and must always open.
  if (event.detail !== 0 && performance.now() < suppressClickUntil) return
  expand()
}

function beginPanelDrag(event: PointerEvent): void {
  if (event.button !== 0) return
  panelDrag = trackPointer(event, window.screenY, 'y')
}

function movePanelDrag(event: PointerEvent): void {
  const drag = panelDrag
  if (!drag || drag.pointerId !== event.pointerId) return
  window.tinadec.companion.moveTo(drag.windowTop + event.screenY - drag.pointerY).catch((error) => {
    console.warn('[companion] moveTo failed:', error)
  })
}

function endPanelDrag(event: PointerEvent): void {
  if (!panelDrag || panelDrag.pointerId !== event.pointerId) return
  panelDrag = null
  dragging.value = false
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !expanded.value) return
  event.preventDefault()
  collapse()
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  // Subscribe before reading: a state change that lands during the read must win over the
  // snapshot, so the initial value is only applied while nothing has arrived yet.
  disposeState = window.tinadec.companion.onStateChanged(applyState)
  try {
    const initial = await window.tinadec.companion.getState()
    if (!state.value) applyState(initial)
  } catch (error) {
    console.warn('[companion] state read failed:', error)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  disposeState?.()
  disposeState = undefined
})
</script>

<template>
  <div
    class="companion"
    :class="{
      'companion--expanded': expanded,
      'companion--dragging': dragging,
      'companion--side-left': side === 'left',
      'companion--side-right': side === 'right',
    }"
  >
    <button
      v-if="!expanded"
      class="companion-capsule"
      type="button"
      :title="t('companion.expand')"
      :aria-label="t('companion.expand')"
      :aria-expanded="false"
      @pointerdown="beginCapsuleDrag"
      @pointermove="moveCapsuleDrag"
      @pointerup="endCapsuleDrag"
      @pointercancel="endCapsuleDrag"
      @click="onCapsuleClick"
    >
      <span class="companion-grip" aria-hidden="true">
        <span class="companion-grip-dot" />
        <span class="companion-grip-dot" />
        <span class="companion-grip-dot" />
      </span>
      <span class="companion-capsule-chevron" aria-hidden="true">
        <ChevronLeft v-if="side === 'right'" :size="15" />
        <ChevronRight v-else :size="15" />
      </span>
    </button>

    <section
      v-else
      class="companion-panel"
      role="region"
      :aria-label="t('companion.title')"
      :title="t('companion.dragHint')"
      @pointerdown="beginPanelDrag"
      @pointermove="movePanelDrag"
      @pointerup="endPanelDrag"
      @pointercancel="endPanelDrag"
    >
      <header class="companion-header">
        <div class="companion-heading">
          <p class="companion-title">{{ t('companion.title') }}</p>
          <p class="companion-subtitle">{{ t('companion.subtitle') }}</p>
        </div>
        <div class="companion-actions">
          <button
            v-if="side === 'right'"
            class="companion-action"
            type="button"
            :title="t('companion.dockLeft')"
            :aria-label="t('companion.dockLeft')"
            @pointerdown.stop
            @click="dock('left')"
          >
            <ChevronsLeft :size="15" />
          </button>
          <button
            v-else
            class="companion-action"
            type="button"
            :title="t('companion.dockRight')"
            :aria-label="t('companion.dockRight')"
            @pointerdown.stop
            @click="dock('right')"
          >
            <ChevronsRight :size="15" />
          </button>
          <button
            class="companion-action"
            type="button"
            :title="t('companion.collapse')"
            :aria-label="t('companion.collapse')"
            @pointerdown.stop
            @click="collapse"
          >
            <ChevronsRight v-if="side === 'right'" :size="15" />
            <ChevronsLeft v-else :size="15" />
          </button>
        </div>
      </header>

      <div class="companion-body">
        <div class="companion-placeholder-mark" aria-hidden="true" />
        <p class="companion-placeholder-title">{{ t('companion.placeholderTitle') }}</p>
        <p class="companion-placeholder-body">{{ t('companion.placeholderBody') }}</p>
      </div>

      <p class="companion-footer">{{ t('companion.footerHint') }}</p>
    </section>
  </div>
</template>

<style scoped>
/* The window is transparent and only as large as the current shape; the OS window has no
   shadow, so every edge this page draws must be its own. */
:global(html),
:global(body),
:global(#app) {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: transparent !important;
}

.companion {
  width: 100%;
  height: 100%;
  overflow: hidden;
  color: var(--text-primary);
  background: transparent;
  user-select: none;
  -webkit-user-select: none;
}

/* ---- Collapsed capsule ---- */

.companion-capsule {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  color: var(--text-muted);
  background: var(--bg-secondary);
  cursor: grab;
  touch-action: none;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}

.companion-capsule:hover {
  border-color: var(--accent-primary);
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

.companion-capsule:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: -3px;
}

.companion--dragging .companion-capsule {
  cursor: grabbing;
}

.companion-grip {
  display: flex;
  flex-direction: column;
  gap: 3px;
  transition: opacity 120ms ease;
}

.companion-grip-dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
}

.companion-capsule-chevron {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  opacity: 0;
  color: var(--accent-primary);
  transition: opacity 120ms ease;
}

.companion-capsule:hover .companion-grip,
.companion-capsule:focus-visible .companion-grip {
  opacity: 0;
}

.companion-capsule:hover .companion-capsule-chevron,
.companion-capsule:focus-visible .companion-capsule-chevron {
  opacity: 1;
}

/* ---- Expanded panel ---- */

.companion-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border: 1px solid var(--border-default);
  border-radius: 14px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  cursor: grab;
  touch-action: none;
}

/* The shape is flush with the screen edge on its docked side: square that side off so the
   rounded corners do not leave a see-through notch against the display border. */
.companion--side-right .companion-panel {
  border-right: 0;
  border-radius: 14px 0 0 14px;
}

.companion--side-left .companion-panel {
  border-left: 0;
  border-radius: 0 14px 14px 0;
}

.companion--dragging .companion-panel {
  cursor: grabbing;
}

.companion-header {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  align-items: center;
  padding: 12px 12px 11px;
  border-bottom: 1px solid var(--border-muted);
}

.companion-heading {
  flex: 1;
  min-width: 0;
}

.companion-title,
.companion-subtitle {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.companion-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
}

.companion-subtitle {
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.3;
}

.companion-actions {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
}

.companion-action {
  display: grid;
  width: 24px;
  height: 24px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 6px;
  color: var(--text-secondary);
  background: transparent;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}

.companion-action:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.companion-action:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: -2px;
}

.companion-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding: 24px;
  overflow: hidden;
  text-align: center;
}

.companion-placeholder-mark {
  display: grid;
  flex-shrink: 0;
  width: 76px;
  height: 76px;
  place-items: center;
  border: 1px solid var(--border-muted);
  border-radius: 18px;
  background: var(--bg-tertiary);
}

.companion-placeholder-mark::before {
  width: 8px;
  height: 40px;
  border: 1px solid color-mix(in srgb, var(--accent-primary) 55%, transparent);
  border-radius: 4px;
  background: var(--accent-soft);
  content: '';
}

.companion-placeholder-title {
  margin: 14px 0 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
}

.companion-placeholder-body {
  max-width: 240px;
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 1.6;
}

.companion-footer {
  flex-shrink: 0;
  margin: 0;
  padding: 10px 12px;
  border-top: 1px solid var(--border-muted);
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.4;
  text-align: center;
}
</style>
