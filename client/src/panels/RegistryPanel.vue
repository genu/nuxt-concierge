<script lang="ts">
import { ref, onMounted } from 'vue'
import { api, type RegistryView } from '../api'
</script>

<script setup lang="ts">
const registry = ref<RegistryView | undefined>()
const error = ref<string | undefined>()

onMounted(async () => {
  try {
    registry.value = await api.registry()
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
})
</script>

<template>
  <div>
    <UAlert v-if="error" color="error" title="Could not load the registry" :description="error" />
    <div v-else-if="registry" class="space-y-3">
      <div v-for="job in registry.jobs" :key="job.name" class="rounded border border-default p-2 text-sm">
        <div class="flex items-center justify-between gap-2">
          <span class="font-medium truncate">{{ job.name }}</span>
          <UBadge size="sm" variant="subtle">
            {{ job.queue }}
          </UBadge>
        </div>
        <p v-if="job.file" class="font-mono text-xs text-muted truncate">
          {{ job.file }}
        </p>
        <div class="mt-1 flex flex-wrap gap-1">
          <UBadge size="sm" :variant="job.hasSchema ? 'subtle' : 'outline'">
            {{ job.hasSchema ? `schema: ${job.schemaVendor}` : 'no schema' }}
          </UBadge>
          <UBadge size="sm" variant="outline">
            attempts {{ job.attempts.value }} ({{ job.attempts.from }})
          </UBadge>
          <UBadge size="sm" variant="outline">
            backoff {{ job.backoff.value.type }} {{ job.backoff.value.delay }}ms ({{ job.backoff.from }})
          </UBadge>
        </div>
      </div>
      <p v-if="!registry.jobs.length" class="text-sm text-muted">
        No jobs are registered.
      </p>

      <details v-if="registry.generatedTypes">
        <summary class="cursor-pointer text-xs font-semibold uppercase text-muted">
          Generated types
        </summary>
        <pre class="mt-1 overflow-auto text-xs">{{ registry.generatedTypes }}</pre>
      </details>
    </div>
    <p v-else class="text-sm text-muted">
      Loading…
    </p>
  </div>
</template>
