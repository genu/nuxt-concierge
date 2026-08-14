<script lang="ts">
import type { Overview } from '../types'

export interface Props {
  overview: Overview
}
</script>

<script setup lang="ts">
const { overview } = defineProps<Props>()
</script>

<template>
  <div class="space-y-3">
    <UAlert
      v-if="!overview.driverHealthy"
      color="error"
      icon="i-lucide-unplug"
      title="The driver connection is down"
      description="Counts below are the last values read and may be stale."
    />
    <UAlert
      v-else-if="!overview.introspectable"
      color="warning"
      icon="i-lucide-eye-off"
      :title="`The ${overview.driver} driver does not support introspection`"
      :description="overview.driver === 'sync'
        ? 'The sync driver runs handlers inline and has no queue, so there is nothing to list. The Registry tab still works.'
        : 'This driver reports no queue contents. The Registry tab still works.'"
    />
    <UAlert
      v-else-if="overview.capabilities?.history === 'bounded'"
      color="neutral"
      variant="subtle"
      icon="i-lucide-history"
      title="Recent results only"
      description="This driver keeps a bounded, in-process history. Older completed and failed jobs are evicted oldest-first and are not durable."
    />

    <section class="space-y-1">
      <h2 class="text-xs font-semibold uppercase text-muted">
        Queues
      </h2>
      <div v-for="q in overview.queues" :key="q.name" class="rounded border border-default p-2 text-sm">
        <div class="flex items-center justify-between">
          <span class="font-medium">{{ q.name }}</span>
          <span class="text-xs text-muted">concurrency {{ q.concurrency }}</span>
        </div>
        <div v-if="q.counts" class="mt-1 flex flex-wrap gap-1">
          <UBadge v-for="(n, state) in q.counts" :key="state" size="sm" variant="subtle">
            {{ state }} {{ n }}
          </UBadge>
        </div>
        <p v-else class="mt-1 text-xs text-muted">
          counts unavailable for this driver
        </p>
      </div>
    </section>

    <section class="space-y-1">
      <h2 class="text-xs font-semibold uppercase text-muted">
        Workers
      </h2>
      <p v-if="!overview.workers.length" class="text-sm text-muted">
        No workers are registered.
      </p>
      <div v-for="w in overview.workers" :key="w.id" class="rounded border border-default p-2 text-sm">
        <div class="flex items-center justify-between gap-2">
          <span class="font-mono text-xs truncate">{{ w.id }}</span>
          <UBadge :color="w.stale ? 'warning' : 'success'" size="sm" variant="subtle">
            {{ w.stale ? 'stale' : w.state }}
          </UBadge>
        </div>
        <p class="text-xs text-muted">
          pid {{ w.pid }} · role {{ w.role }} · {{ w.active.length }} active
        </p>
        <div class="mt-1 flex flex-wrap gap-1">
          <UBadge v-for="(n, q) in w.concurrency" :key="q" size="sm" variant="outline">
            {{ q }}: {{ n }}
          </UBadge>
        </div>
      </div>
    </section>
  </div>
</template>
