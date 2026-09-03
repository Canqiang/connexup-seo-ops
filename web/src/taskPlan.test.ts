import { describe, expect, it } from 'vitest'
import { executionWaves, type TaskPlanItem } from './taskPlan'

function task(key: string, depends_on: string[] = []): TaskPlanItem {
  return {
    key,
    task_type: 'PREPARE_ONLY',
    title: key,
    rationale: `${key} rationale`,
    expected_outcome: `${key} outcome`,
    depends_on,
    scheduled_start: null,
    parameters: {},
  }
}

describe('executionWaves', () => {
  it('groups a valid plan into stable execution waves', () => {
    expect(executionWaves([
      task('review', ['draft']),
      task('publish', ['review']),
      task('draft'),
      task('research'),
    ]).map(wave => wave.map(item => item.key))).toEqual([
      ['draft', 'research'],
      ['review'],
      ['publish'],
    ])
  })

  it('rejects missing dependency references with the affected keys', () => {
    expect(() => executionWaves([task('publish', ['draft'])]))
      .toThrow('任务 publish 引用了不存在的前置任务 draft')
  })

  it('rejects dependency cycles instead of rendering a partial graph', () => {
    expect(() => executionWaves([
      task('draft', ['review']),
      task('review', ['draft']),
    ])).toThrow('Plan 存在循环依赖：draft、review')
  })

  it('rejects duplicate Task keys before attempting to order them', () => {
    expect(() => executionWaves([task('draft'), task('draft')]))
      .toThrow('Plan 存在重复 Task key：draft')
  })
})
