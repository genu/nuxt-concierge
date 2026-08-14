import { describe, it, expect } from 'vitest'
import { parsePaging } from '../../../src/runtime/server/routes/api/jobs-list'

describe('parsePaging', () => {
  it('falls back to the default offset/limit for Infinity', () => {
    // `Number('Infinity')` is `Infinity`, which is truthy and not `NaN` — the
    // previous `Number(query.offset ?? 0) || 0` fallback only caught `NaN`,
    // so this used to reach the bullmq driver as a literal `Infinity` and
    // Redis rejected it as a non-integer range argument, surfacing as a 500
    // instead of this handler's own bounded response.
    expect(parsePaging({ offset: 'Infinity', limit: 'Infinity' })).toEqual({ offset: 0, limit: 25 })
  })

  it('falls back to the default offset/limit for NaN', () => {
    expect(parsePaging({ offset: 'banana', limit: 'banana' })).toEqual({ offset: 0, limit: 25 })
  })

  it('truncates a fractional offset and limit rather than passing them through', () => {
    // `1.5`/`25.7` are finite, valid numbers — they must not fall back to the
    // default, but they also must not reach Redis as a non-integer range.
    expect(parsePaging({ offset: '1.5', limit: '25.7' })).toEqual({ offset: 1, limit: 25 })
  })

  it('clamps a negative offset to 0 and a negative limit to 1', () => {
    expect(parsePaging({ offset: '-5', limit: '-5' })).toEqual({ offset: 0, limit: 1 })
  })

  it('clamps a limit above MAX_LIMIT down to 100', () => {
    expect(parsePaging({ limit: '1000000' })).toEqual({ offset: 0, limit: 100 })
  })

  it('uses the defaults when neither is supplied', () => {
    expect(parsePaging({})).toEqual({ offset: 0, limit: 25 })
  })
})
