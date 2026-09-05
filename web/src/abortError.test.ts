import { describe, expect, it } from 'vitest'
import { isAbortError } from './api'

describe('isAbortError', () => {
  it('recognises the DOMException a real fetch raises on abort', () => {
    expect(isAbortError(new DOMException('The operation was aborted.', 'AbortError'))).toBe(true)
  })

  it('recognises a plain Error carrying the AbortError name', () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    expect(isAbortError(error)).toBe(true)
  })

  it('rejects other errors and non-errors', () => {
    expect(isAbortError(new Error('boom'))).toBe(false)
    expect(isAbortError({ name: 'AbortError' })).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })
})
