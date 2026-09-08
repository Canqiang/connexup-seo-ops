// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import TaskAssignment from './TaskAssignment'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each([true, false])('shows dedicated Agent binding state without implying automatic execution (%s)', (bound) => {
  render(<TaskAssignment taskId={7} version={2} assignment={{ assignee_type: 'AGENT', assignee_id: 'local-agent', display_name: '内容 Agent' }} agentBound={bound} disabled={false} onSaved={() => {}} />)
  screen.getByText('责任分配不会自动开始执行。')
  if (bound) screen.getByText('已配置专用 Agent；开始前会校验配置，准备结果仍需 AM 审批，不会自动发布。')
  else screen.getByText('专用 Agent 未配置执行绑定或已停用，不能使用默认内容准备通道。')
})
const options = [
  { assignee_type: 'HUMAN', assignee_id: 'test', display_name: 'AM · test' },
  { assignee_type: 'AGENT', assignee_id: 'agent-local', display_name: '内容 Agent' },
]
function setup(status = 200, locked = false) {
  const writes: unknown[] = []
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      writes.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify(status === 200 ? { version: 3 } : { detail: '任务已变化' }), { status })
    }
    return new Response(JSON.stringify({ assignment: null, version: 2, options,
      can_change: !locked, lock_reason: locked ? '执行结果未知' : null }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetcher)
  const saved = vi.fn()
  render(<TaskAssignment taskId={7} version={2} assignment={null} disabled={false} onSaved={saved} />)
  return { writes, saved, fetcher }
}

it('loads choices only on request and saves authenticated AM identity with version', async () => {
  const { writes, saved, fetcher } = setup()
  expect(fetcher).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '分配负责人' }))
  const select = await screen.findByRole('combobox', { name: '选择负责人' })
  fireEvent.change(select, { target: { value: 'HUMAN:test' } })
  fireEvent.change(screen.getByLabelText('分配原因'), { target: { value: '我来跟进' } })
  fireEvent.click(screen.getByRole('button', { name: '保存分配' }))
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  expect(writes).toEqual([{ expected_version: 2, assignee_type: 'HUMAN', assignee_id: 'test', reason: '我来跟进' }])
})

it('selects a local Agent identity without invoking an execution endpoint', async () => {
  const { writes, saved, fetcher } = setup()
  fireEvent.click(screen.getByRole('button', { name: '分配负责人' }))
  fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'AGENT:agent-local' } })
  fireEvent.change(screen.getByLabelText('分配原因'), { target: { value: '分配内容准备' } })
  fireEvent.click(screen.getByRole('button', { name: '保存分配' }))
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  expect(writes[0]).toMatchObject({ assignee_type: 'AGENT', assignee_id: 'agent-local' })
  expect(fetcher.mock.calls.every(([url]) => url === '/api/tasks/7/assignment')).toBe(true)
})

it('does not retry on conflict and requires explicit refresh', async () => {
  const { writes, saved } = setup(409)
  fireEvent.click(screen.getByRole('button', { name: '分配负责人' }))
  fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'HUMAN:test' } })
  fireEvent.change(screen.getByLabelText('分配原因'), { target: { value: '转交' } })
  fireEvent.click(screen.getByRole('button', { name: '保存分配' }))
  await screen.findByRole('alert')
  expect(writes).toHaveLength(1)
  expect(saved).not.toHaveBeenCalled()
  expect((screen.getByRole('button', { name: '保存分配' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('button', { name: '重新加载负责人' })).toBeTruthy()
})

it('honors server lock even when the parent snapshot is stale', async () => {
  const { writes } = setup(200, true)
  fireEvent.click(screen.getByRole('button', { name: '分配负责人' }))
  await screen.findByText('执行结果未知')
  expect((screen.getByRole('button', { name: '保存分配' }) as HTMLButtonElement).disabled).toBe(true)
  expect(writes).toHaveLength(0)
})

it('cancels editing without writing', async () => {
  const { writes } = setup()
  fireEvent.click(screen.getByRole('button', { name: '分配负责人' }))
  await screen.findByRole('combobox')
  fireEvent.click(screen.getByRole('button', { name: '取消分配编辑' }))
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(writes).toHaveLength(0)
})
