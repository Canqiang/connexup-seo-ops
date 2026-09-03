import type { SeoTargetState } from './api'

export function keywordIdentity(value: string) {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\p{White_Space}+/gu, ' ')
    .toLocaleLowerCase()
}

export type LocalFalconBatchReadbackExpectation = {
  requestId: string
  approvalId: number
  expectedScanConfigSha256: string
  keywordArtifactId: number
  expectedCohortSha256: string
}

export function isAcceptedLocalFalconBatchReadback(
  state: SeoTargetState,
  expected: LocalFalconBatchReadbackExpectation,
) {
  const batch = state.local_falcon?.scan_batch
  const approval = state.local_falcon?.approval
  return Boolean(
    batch
    && approval
    && ['submitting', 'submitted', 'partial', 'completed'].includes(batch.status)
    && batch.request_id === expected.requestId
    && batch.approval_id === expected.approvalId
    && batch.scan_config_sha256 === expected.expectedScanConfigSha256
    && approval.id === expected.approvalId
    && approval.keyword_artifact_id === expected.keywordArtifactId
    && approval.cohort_sha256 === expected.expectedCohortSha256,
  )
}
