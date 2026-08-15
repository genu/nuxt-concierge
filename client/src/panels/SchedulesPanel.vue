<script lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'
import type { ScheduleView } from '../api'
import type { Overview } from '../types'

interface Props {
  overview: Overview
}
</script>

<script setup lang="ts">
const { overview } = defineProps<Props>()

const schedules = ref<ScheduleView[]>([])
// Named by the server, not inferred here: a queue lands in this list only
// when its own driver read timed out, and the healthy case is an empty
// array. Rendering it verbatim is what keeps "no schedules declared" and
// "some queues could not be read" two visibly different states instead of
// one silently short list.
const unreadableQueues = ref<string[]>([])
const error = ref<string | undefined>()
const notice = ref<string | undefined>()

const load = async () => {
  if (!overview.schedulable) return
  try {
    const res = await api.schedules()
    schedules.value = res.items
    unreadableQueues.value = res.unreadableQueues
    error.value = undefined
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

const run = async (jobName: string) => {
  try {
    const result = await api.runSchedule(jobName)
    // The deduplicated flag is surfaced, not swallowed. A run-now that
    // silently did nothing because a dedup key was held is exactly the
    // "why didn't my job run?" case the flag exists to answer.
    notice.value = result.deduplicated
      ? `"${jobName}" was deduplicated — an identical job is already queued or running.`
      : `"${jobName}" enqueued as ${result.id}.`
    await load()
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

const formatTime = (ms?: number) => (ms === undefined ? '—' : new Date(ms).toLocaleString())

onMounted(load)
</script>

<template>
  <div class="space-y-3">
    <UAlert
      v-if="!overview.schedulable"
      color="neutral"
      variant="subtle"
      icon="i-lucide-calendar-off"
      title="This driver cannot schedule"
      :description="`The ${overview.driver} driver does not implement scheduling, so no cron job will fire.`"
    />
    <template v-else>
      <UAlert v-if="error" color="error" title="Cannot read schedules" :description="error" />
      <UAlert v-if="notice" color="neutral" variant="subtle" :description="notice" />

      <!--
        A named, per-queue warning, not folded into the generic `error` alert
        above: `unreadableQueues` can be non-empty on an otherwise-successful
        response (some queues answered, one timed out), and collapsing that
        into the same slot as a hard failure would either hide it behind a
        successful load or make a partial read look like a total one.
      -->
      <UAlert
        v-if="unreadableQueues.length"
        color="warning"
        icon="i-lucide-triangle-alert"
        title="Some queues could not be read"
        :description="`The following queue(s) did not respond in time, so their schedules are missing below: ${unreadableQueues.join(', ')}.`"
      />

      <p v-if="!schedules.length && !unreadableQueues.length && !error" class="text-sm text-muted">
        No cron jobs are declared. Add <code>cron</code> to a job in <code>server/jobs/</code>.
      </p>

      <UTable
        v-else-if="schedules.length"
        :data="schedules"
        :columns="[
          { accessorKey: 'jobName', header: 'Job' },
          { accessorKey: 'queue', header: 'Queue' },
          { accessorKey: 'expression', header: 'Schedule' },
          { accessorKey: 'tz', header: 'Timezone' },
          { accessorKey: 'next', header: 'Next run' },
          { accessorKey: 'iterationCount', header: 'Ticks' },
          { id: 'actions', header: '' },
        ]"
      >
        <template #next-cell="{ row }">
          {{ formatTime(row.original.next) }}
        </template>
        <template #iterationCount-cell="{ row }">
          {{ row.original.iterationCount ?? '—' }}
        </template>
        <template #actions-cell="{ row }">
          <UButton size="xs" variant="ghost" icon="i-lucide-play" @click="run(row.original.jobName)">
            Run now
          </UButton>
        </template>
      </UTable>
    </template>
  </div>
</template>
