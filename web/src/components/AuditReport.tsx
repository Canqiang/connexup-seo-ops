import type { AuditArea, AuditEvidenceMode, AuditSeverity, AuditSnapshot } from '../api'

const EVIDENCE_MODE_LABELS: Record<AuditEvidenceMode, string> = {
  PUBLIC_AND_CONFIRMED: '公开资料 + 已确认信息',
  CONNECTED_AND_CONFIRMED: '已连接数据 + 已确认信息',
  CONFIRMED_FACTS_ONLY: '仅已确认信息',
}

const AREA_LABELS: Record<AuditArea, string> = {
  GBP: 'Google 商户资料',
  WEBSITE: '官网',
  LOCAL_CONTENT: '本地内容',
  TECHNICAL: '技术 SEO',
  CITATIONS: '本地引用',
  REVIEWS: '评论口碑',
  ANALYTICS: '数据分析',
  OTHER: '其他',
}

const SEVERITY_LABELS: Record<AuditSeverity, string> = {
  CRITICAL: '严重',
  HIGH: '高优先级',
  MEDIUM: '中优先级',
  LOW: '低优先级',
  INFO: '提示',
}

export default function AuditReport({ snapshot }: { snapshot: AuditSnapshot }) {
  const { audit } = snapshot

  return (
    <article className="audit-report" aria-label="Audit 报告">
      <header className="audit-conclusion">
        <div className="audit-kicker">
          <span>已验收 AUDIT</span>
          <span className="audit-evidence-mode">{EVIDENCE_MODE_LABELS[audit.evidence_mode]}</span>
        </div>
        <h2>{audit.title}</h2>
        <p>{audit.summary}</p>
      </header>

      <section className="audit-findings" aria-labelledby="audit-findings-title">
        <div className="audit-section-head">
          <h3 id="audit-findings-title">核心问题</h3>
          <span>{audit.findings.length} 项</span>
        </div>
        <ol>
          {audit.findings.map((finding, index) => (
            <li className={`audit-finding severity-${finding.severity.toLowerCase()}`} key={finding.id}>
              <div className="audit-finding-index">{String(index + 1).padStart(2, '0')}</div>
              <div className="audit-finding-body">
                <div className="audit-finding-meta">
                  <span>{AREA_LABELS[finding.area]}</span>
                  <span className={`audit-severity ${finding.severity.toLowerCase()}`}>
                    {SEVERITY_LABELS[finding.severity]}
                  </span>
                </div>
                <h4>{finding.observation}</h4>
                <div className="audit-evidence-rail">
                  <section>
                    <h5>核验证据</h5>
                    <ul>
                      {finding.evidence.map(item => <li key={item}>{item}</li>)}
                    </ul>
                  </section>
                  <section>
                    <h5>建议处置</h5>
                    <p>{finding.recommendation}</p>
                  </section>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <footer className="audit-notes">
        <section>
          <h3>数据限制</h3>
          {audit.limitations.length > 0
            ? <ul>{audit.limitations.map(item => <li key={item}>{item}</li>)}</ul>
            : <p>本次 Audit 未标记额外数据限制。</p>}
        </section>
        <section>
          <h3>下一步行动</h3>
          <ol>{audit.next_actions.map(item => <li key={item}>{item}</li>)}</ol>
        </section>
      </footer>
    </article>
  )
}
