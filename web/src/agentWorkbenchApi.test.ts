import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, api } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('agent workbench API', () => {
  it('getAgentWorkbench sends range and AbortSignal', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ snapshot_at: '2026-09-03T00:00:00Z' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await api.getAgentWorkbench('30d', controller.signal)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent-workbench?range=30d',
      expect.objectContaining({ signal: controller.signal, credentials: 'same-origin' }),
    )
  })

  it('aggregate preserves statusless signal shape', async () => {
    const payload = {
      snapshot_at: '2026-09-03T00:00:00Z',
      signals: [
        {
          coreai_run_id: 'accepted-run',
          raw_status: null,
          presentation_group: 'unknown',
          token_state: 'unconfirmed',
        },
      ],
      agents: [
        {
          id: 'local-agent',
          last_terminal_run: {
            coreai_run_id: 'accepted-history-run',
            raw_status: null,
            presentation_group: 'unknown',
            token_state: 'unconfirmed',
          },
        },
      ],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    const snapshot = await api.getAgentWorkbench('7d', new AbortController().signal)

    expect(snapshot).toEqual(payload)
    expect(snapshot.signals[0].raw_status).toBeNull()
    expect(snapshot.signals[0].presentation_group).toBe('unknown')
    expect(snapshot.signals[0].token_state).toBe('unconfirmed')
    expect(snapshot.agents[0].last_terminal_run?.raw_status).toBeNull()
    expect(snapshot.agents[0].last_terminal_run?.presentation_group).toBe('unknown')
    expect(snapshot.agents[0].last_terminal_run?.token_state).toBe('unconfirmed')
  })

  it('history URL encodes path and cursor', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [],
          next_before: null,
          range: '7d',
          timezone: 'Asia/Shanghai',
          range_start: null,
          range_end: '2026-09-03T16:00:00+00:00',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await api.getAgentRunHistory('local agent/1', '7d', 20, 'opaque+cursor', controller.signal)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent-workbench/agents/local%20agent%2F1/runs?range=7d&limit=20&before=opaque%2Bcursor',
      expect.objectContaining({ signal: controller.signal, credentials: 'same-origin' }),
    )
  })

  it('registerAgent sends strict body', async () => {
    const body = {
      coreai_agent_id: 'agent-extra',
      agent_key: 'citation-monitor',
      display_name: 'Citation Monitor Agent',
      role: '监控关键引用与目录变化',
      sort_order: 70,
      suspect_after_seconds: 1800,
    }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ agent: {}, sync_pending: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await api.registerAgent(body)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent-workbench/agents',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(body),
        credentials: 'same-origin',
      }),
    )
  })

  it('updateAgent sends encoded id and strict body', async () => {
    const body = {
      display_name: 'Updated Agent',
      role: '更新后的角色',
      sort_order: -3,
      suspect_after_seconds: 600,
      lifecycle_status: 'disabled' as const,
    }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ agent: {}, sync_pending: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await api.updateAgent('local agent/1', body)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent-workbench/agents/local%20agent%2F1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify(body),
        credentials: 'same-origin',
      }),
    )
  })

  it('retireAgent sends zero-byte body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ agent: {}, sync_pending: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await api.retireAgent('local agent/1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent-workbench/agents/local%20agent%2F1/retire',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    )
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init).not.toHaveProperty('body')
  })

  it('replaceAgent sends encoded id and strict body', async () => {
    const body = {
      coreai_agent_id: 'replacement-agent',
      display_name: 'Replacement Agent',
      role: '接替原有 Agent',
      sort_order: 8,
      suspect_after_seconds: 900,
    }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ agent: {}, sync_pending: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await api.replaceAgent('local agent/1', body)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent-workbench/agents/local%20agent%2F1/replace',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(body),
        credentials: 'same-origin',
      }),
    )
  })

  it('structured and legacy API errors', async () => {
    const nullPrototypeFields = Object.assign(Object.create(null), { agent_key: '已存在' }) as Record<string, string>
    const prototypeFields = Object.assign(Object.create({ inherited: 'not allowed' }), { role: '无效' }) as Record<
      string,
      string
    >
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ detail: 'legacy detail' }), {
            status: 400,
            statusText: 'Bad Request',
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              detail: {
                message: 'Agent validation failed',
                code: 'VALIDATION_ERROR',
                fields: { role: '必填', sort_order: '必须是整数' },
              },
            }),
            {
              status: 422,
              statusText: 'Unprocessable Entity',
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        )
        .mockResolvedValueOnce({
          ok: false,
          status: 409,
          statusText: 'Conflict',
          json: async () => ({
            detail: {
              message: 'Agent key conflict',
              code: 'AGENT_KEY_CONFLICT',
              fields: nullPrototypeFields,
            },
          }),
        })
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              detail: { message: 'Array fields', code: 'VALIDATION_ERROR', fields: ['not', 'a', 'map'] },
            }),
            {
              status: 422,
              statusText: 'Unprocessable Entity',
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        )
        .mockResolvedValueOnce({
          ok: false,
          status: 422,
          statusText: 'Unprocessable Entity',
          json: async () => ({ detail: { message: 'Date fields', fields: new Date('2026-09-03T00:00:00Z') } }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 422,
          statusText: 'Unprocessable Entity',
          json: async () => ({ detail: { message: 'Prototype fields', fields: prototypeFields } }),
        })
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ detail: { message: 'Scalar value', fields: { role: '无效', sort_order: 70 } } }),
            {
              status: 422,
              statusText: 'Unprocessable Entity',
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        ),
    )

    const legacy = await api.getAgentWorkbench('30d', new AbortController().signal).catch(error => error)
    expect(legacy).toBeInstanceOf(ApiError)
    expect(legacy).toMatchObject({ message: 'legacy detail', status: 400 })

    const structured = await api.getAgentWorkbench('30d', new AbortController().signal).catch(error => error)
    expect(structured).toBeInstanceOf(ApiError)
    expect(structured).toMatchObject({
      message: 'Agent validation failed',
      status: 422,
      code: 'VALIDATION_ERROR',
      fields: { role: '必填', sort_order: '必须是整数' },
    })

    const nullPrototype = await api.getAgentWorkbench('30d', new AbortController().signal).catch(error => error)
    expect(nullPrototype).toMatchObject({
      message: 'Agent key conflict',
      status: 409,
      code: 'AGENT_KEY_CONFLICT',
      fields: nullPrototypeFields,
    })

    const arrayFields = await api.getAgentWorkbench('30d', new AbortController().signal).catch(error => error)
    expect(arrayFields).toMatchObject({ message: 'Array fields', status: 422, code: 'VALIDATION_ERROR', fields: {} })

    const dateFields = await api.getAgentWorkbench('30d', new AbortController().signal).catch(error => error)
    expect(dateFields.message).toBe('Date fields')
    expect(dateFields.fields).toEqual({})

    const prototypeBearingFields = await api
      .getAgentWorkbench('30d', new AbortController().signal)
      .catch(error => error)
    expect(prototypeBearingFields.message).toBe('Prototype fields')
    expect(prototypeBearingFields.fields).toEqual({})

    const scalarValueFields = await api.getAgentWorkbench('30d', new AbortController().signal).catch(error => error)
    expect(scalarValueFields.message).toBe('Scalar value')
    expect(scalarValueFields.fields).toEqual({})
  })
})
