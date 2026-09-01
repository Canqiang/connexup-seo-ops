const JSON_FENCE = /^\s*```json[^\n]*\n[\s\S]*?^\s*```\s*$/gim

export function reportForDisplay(report: string) {
  const withoutPlanPayload = report.replace(JSON_FENCE, '')

  if (withoutPlanPayload === report) return report

  return withoutPlanPayload.replace(/\n{3,}/g, '\n\n').trim()
}
