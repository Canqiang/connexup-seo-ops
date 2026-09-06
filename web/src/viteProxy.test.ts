import { describe, expect, it } from 'vitest'

import config from '../vite.config'

describe('development proxy', () => {
  it('vite proxy targets IPv4 loopback', () => {
    expect(config).toMatchObject({ server: { proxy: { '/api': 'http://127.0.0.1:8000' } } })
  })
})
