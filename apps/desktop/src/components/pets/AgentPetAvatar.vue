<script setup lang="ts">
import { PawPrint } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useAgentAvatars } from '@/composables/useAgentAvatars'

/**
 * One agent's face.
 *
 * The sprite sheet is an 8-column grid of 192x208 frames; showing frame (0,0) is a matter of
 * making the image eight times wider than the slot and letting `overflow: hidden` do the crop —
 * the same trick `PetPreview` uses at card scale, without its lazy-loading machinery.
 *
 * Two ways to bind:
 * - `instance-key` (+ `agent-id`): the face of one spawned agent, resolved and persisted once.
 * - `pet-slug`: a literal pet, for settings previews and pinned choices.
 *
 * A missing image is never an empty hole: it falls back to a glyph, and the URL layer already
 * degrades a deleted pet to the bundled one.
 */
const props = withDefaults(defineProps<{
  instanceKey?: string
  agentId?: string | null
  petSlug?: string
  /** Width in pixels; the height follows the 192:208 frame. */
  size?: number
  alt?: string
}>(), {
  instanceKey: '',
  agentId: null,
  petSlug: '',
  size: 20,
  alt: '',
})

const { urlForSlug, resolveInstanceAvatar, revision } = useAgentAvatars()
const resolvedSlug = ref(props.petSlug)

async function sync() {
  if (props.petSlug) {
    resolvedSlug.value = props.petSlug
    return
  }
  if (!props.instanceKey) {
    resolvedSlug.value = ''
    return
  }
  resolvedSlug.value = await resolveInstanceAvatar(props.instanceKey, props.agentId) ?? ''
}

watch(
  () => [props.petSlug, props.instanceKey, props.agentId, revision.value] as const,
  () => { void sync() },
  { immediate: true },
)

const url = computed(() => urlForSlug(resolvedSlug.value))
const glyphSize = computed(() => Math.max(10, Math.round(props.size * 0.58)))
</script>

<template>
  <span
    class="agent-pet-avatar"
    :style="{ '--agent-avatar-size': `${size}px` }"
    :data-pet-slug="resolvedSlug || undefined"
    aria-hidden="true"
  >
    <img v-if="url" :src="url" :alt="alt" draggable="false" />
    <PawPrint v-else :size="glyphSize" class="agent-pet-avatar-fallback" />
  </span>
</template>

<style scoped>
.agent-pet-avatar {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--agent-avatar-size);
  aspect-ratio: 192 / 208;
  overflow: hidden;
  vertical-align: middle;
}

.agent-pet-avatar img {
  display: block;
  width: 800%;
  max-width: none;
  height: auto;
  image-rendering: pixelated;
  user-select: none;
  pointer-events: none;
}

.agent-pet-avatar-fallback {
  color: var(--text-muted);
}
</style>
