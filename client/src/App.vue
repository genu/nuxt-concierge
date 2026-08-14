<script lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import OverviewPanel from './panels/OverviewPanel.vue'
import JobsPanel from './panels/JobsPanel.vue'
import RegistryPanel from './panels/RegistryPanel.vue'
import { api } from './api'
import type { Overview } from './types'
</script>

<script setup lang="ts">
const overview = ref<Overview | undefined>()
const error = ref<string | undefined>()
const paused = ref(false)
let timer: ReturnType<typeof setInterval> | undefined

// prefers-color-scheme plus a manual override, NEVER read off window.parent.
// Sniffing the DevTools frame's theme class would work today (same origin in
// dev) and would couple this panel to someone else's DOM.
const dark = ref(
  localStorage.getItem('concierge-theme')
    ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
)
const applyTheme = () => {
  document.documentElement.classList.toggle('dark', dark.value === 'dark')
  localStorage.setItem('concierge-theme', dark.value)
}
const toggleTheme = () => {
  dark.value = dark.value === 'dark' ? 'light' : 'dark'
  applyTheme()
}

const load = async () => {
  try {
    // Goes through `api.overview()`, not a hand-rolled `fetch(...).json()`:
    // `api.ts`'s `json()` helper checks `res.ok` and throws the server's own
    // `{ error }` message on a non-200 response. Without it, a 503 body (e.g.
    // "no introspection", the role-gate's refusal) would be assigned straight
    // to `overview.value` as if it were a real `Overview` — every field
    // `undefined` — and this `catch` would never see it.
    overview.value = await api.overview()
    error.value = undefined
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

onMounted(() => {
  applyTheme()
  void load()
  timer = setInterval(() => { if (!paused.value) void load() }, 2000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="p-3 space-y-3">
    <header class="flex items-center justify-between gap-2">
      <h1 class="text-sm font-semibold">Concierge</h1>
      <div class="flex items-center gap-1">
        <UButton
          size="xs"
          variant="ghost"
          :icon="paused ? 'i-lucide-play' : 'i-lucide-pause'"
          :aria-label="paused ? 'Resume polling' : 'Pause polling'"
          @click="paused = !paused"
        />
        <UButton size="xs" variant="ghost" icon="i-lucide-contrast" aria-label="Toggle theme" @click="toggleTheme" />
      </div>
    </header>

    <UAlert v-if="error" color="error" :title="'Cannot reach the Concierge API'" :description="error" />
    <p v-else-if="!overview" class="text-sm text-muted">
      Connecting…
    </p>
    <UAlert
      v-else-if="overview.state === 'absent' || overview.state === 'starting'"
      color="neutral"
      variant="subtle"
      icon="i-lucide-loader"
      title="Concierge is starting"
      description="The supervisor has not finished booting. This panel will populate on its own."
    />
    <UTabs
      v-else
      :items="[
        { label: 'Overview', slot: 'overview' },
        { label: 'Jobs', slot: 'jobs' },
        { label: 'Registry', slot: 'registry' },
      ]"
      size="xs"
    >
      <template #overview>
        <OverviewPanel :overview="overview" />
      </template>
      <template #jobs>
        <JobsPanel :overview="overview" />
      </template>
      <template #registry>
        <RegistryPanel />
      </template>
    </UTabs>
  </div>
</template>
