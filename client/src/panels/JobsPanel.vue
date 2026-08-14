<script lang="ts">
import { ref, watch } from 'vue'
import { api, type JobSummaryView, type JobDetailView } from '../api'
import type { Overview } from '../types'

export interface Props {
  overview: Overview
}

const STATES = ['failed', 'waiting', 'active', 'delayed', 'completed'] as const
</script>

<script setup lang="ts">
const { overview } = defineProps<Props>()

const queue = ref(overview.queues[0]?.name ?? '')
const state = ref<string>('failed')
const items = ref<JobSummaryView[]>([])
const total = ref(0)
const selected = ref<JobDetailView | undefined>()
const error = ref<string | undefined>()

const load = async () => {
  // The server's own flag, not a client-derived guess: a driver with no
  // `introspect` answers every list/detail/retry call with a 503, so this
  // check exists to render a deliberate explanation instead of that error.
  if (!overview.introspectable) return
  if (!queue.value) return
  try {
    const res = await api.jobs(queue.value, state.value)
    items.value = res.items
    total.value = res.total
    error.value = undefined
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

const open = async (id: string) => {
  // A row from `items` can still 404 by the time it is opened — the memory
  // driver's bounded history may have evicted it in between the list load
  // and this click. Surfaced the same way as any other fetch failure rather
  // than left as an unhandled rejection.
  try {
    selected.value = await api.job(queue.value, id)
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

const retry = async (id: string) => {
  try {
    await api.retry(queue.value, id)
    selected.value = undefined
    await load()
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

watch([queue, state], load, { immediate: true })
</script>

<template>
  <div class="space-y-2">
    <UAlert
      v-if="!overview.introspectable"
      color="warning"
      icon="i-lucide-eye-off"
      :title="`The ${overview.driver} driver does not support introspection`"
      :description="overview.driver === 'sync'
        ? 'The sync driver runs handlers inline and has no queue, so there is nothing to list here. The Registry tab still works.'
        : 'This driver reports no queue contents. The Registry tab still works.'"
    />
    <template v-else>
      <div class="flex flex-wrap gap-2">
        <USelect v-model="queue" :items="overview.queues.map(q => q.name)" size="xs" />
        <USelect v-model="state" :items="[...STATES]" size="xs" />
        <UButton size="xs" variant="ghost" icon="i-lucide-refresh-cw" aria-label="Reload" @click="load" />
      </div>

      <UAlert v-if="error" color="error" :description="error" />

      <p class="text-xs text-muted">
        {{ total }} job(s)
      </p>

      <button
        v-for="job in items"
        :key="job.id"
        type="button"
        class="block w-full rounded border border-default p-2 text-left text-sm hover:bg-elevated"
        @click="open(job.id)"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="font-medium truncate">{{ job.name }}</span>
          <span class="font-mono text-xs text-muted truncate">{{ job.id }}</span>
        </div>
        <p class="text-xs text-muted">
          attempt {{ job.attemptsMade }}<span v-if="job.attempts"> of {{ job.attempts }}</span>
        </p>
        <p v-if="job.failedReason" class="mt-1 text-xs text-error truncate">
          {{ job.failedReason }}
        </p>
      </button>

      <!--
        `:open` takes a BOOLEAN, so binding the selected object directly (an
        earlier draft of this plan did) type-errors and leaves the drawer stuck
        open. The close handler clears the selection, which is what the
        drawer's open state is actually derived from.
      -->
      <USlideover
        :open="Boolean(selected)"
        :title="selected?.name"
        @update:open="(value: boolean) => { if (!value) selected = undefined }"
      >
        <template #body>
          <div v-if="selected" class="space-y-3 text-sm">
            <UButton
              v-if="selected.state === 'failed'"
              size="xs"
              icon="i-lucide-rotate-ccw"
              @click="retry(selected.id)"
            >
              Retry this job
            </UButton>

            <div>
              <h3 class="text-xs font-semibold uppercase text-muted">
                Payload
              </h3>
              <pre v-if="selected.payload.ok" class="overflow-auto text-xs">{{ selected.payload.value }}</pre>
              <UAlert
                v-else
                color="error"
                title="This payload could not be decoded"
                :description="selected.payload.error"
              />
            </div>

            <div v-if="selected.failedReason">
              <h3 class="text-xs font-semibold uppercase text-muted">
                Error
              </h3>
              <p class="text-xs">
                {{ selected.failedReason }}
              </p>
              <pre v-if="selected.stack" class="mt-1 overflow-auto text-xs text-muted">{{ selected.stack }}</pre>
            </div>
          </div>
        </template>
      </USlideover>
    </template>
  </div>
</template>
