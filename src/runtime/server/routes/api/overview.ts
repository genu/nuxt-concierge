import { defineEventHandler } from 'h3'
import { getSupervisor } from '../../supervisor'
import { buildOverview } from '../../introspect'

/**
 * Registered only under nuxt.options.dev (see src/module.ts), so this file is
 * never part of a production bundle. It therefore needs no auth check — there
 * is deliberately no configuration that makes it reachable in production.
 */
export default defineEventHandler(async () => buildOverview(getSupervisor()))
