import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Command,
  FileBarChart,
  FolderKanban,
  LayoutDashboard,
  ListTodo,
  MessageSquareText,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Store,
  X,
  Zap
} from "lucide-react";
import { bucketMeta, merchants, tasks, type ExecutionTask, type TaskBucket } from "./data";
import "./styles.css";

const navigation = [
  { label: "控制塔", icon: LayoutDashboard },
  { label: "客户工作区", icon: Store },
  { label: "执行中心", icon: ListTodo, active: true, badge: 3 },
  { label: "Agent 运行", icon: Bot, badge: 1 },
  { label: "分析中心", icon: BarChart3 },
  { label: "报告中心", icon: FileBarChart },
  { label: "资产与配置", icon: Settings2 }
];

const bucketOrder: TaskBucket[] = ["decision", "blocked", "today", "after"];

function EvidenceRail({ task }: { task: ExecutionTask }) {
  return (
    <div className="evidence-rail" aria-label={`证据链 ${task.evidenceCount}`}>
      {task.steps.map((step) => (
        <div className={`evidence-step is-${step.state}`} key={step.label}>
          <span className="evidence-dot">{step.state === "done" ? <Check size={10} /> : null}</span>
          <span>{step.label}</span>
        </div>
      ))}
    </div>
  );
}

function TaskRow({ task, onOpen }: { task: ExecutionTask; onOpen: (task: ExecutionTask) => void }) {
  return (
    <button
      aria-label={`查看任务：${task.title}`}
      className="task-row"
      onClick={() => onOpen(task)}
      type="button"
    >
      <div className="task-priority" data-priority={task.priority}>{task.priority}</div>
      <div className="task-main">
        <div className="task-heading-line">
          <strong>{task.title}</strong>
          <span className="task-merchant">{task.merchantName}</span>
        </div>
        <p>{task.nextAction}</p>
        <EvidenceRail task={task} />
      </div>
      <div className="task-meta">
        <span>{task.owner}</span>
        <span className={task.bucket === "blocked" ? "is-overdue" : ""}>
          <Clock3 size={13} /> {task.due}
        </span>
      </div>
      <ChevronRight className="task-arrow" size={17} />
    </button>
  );
}

function TaskDrawer({ task, onClose }: { task: ExecutionTask; onClose: () => void }) {
  return (
    <div className="drawer-layer">
      <button className="drawer-backdrop" aria-label="点击遮罩关闭任务详情" onClick={onClose} type="button" />
      <aside className="task-drawer" role="dialog" aria-modal="true" aria-label="任务详情">
        <div className="drawer-header">
          <div>
            <span className="eyebrow">TASK / {task.id.toUpperCase()}</span>
            <h2>{task.title}</h2>
          </div>
          <button className="icon-button" aria-label="关闭任务详情" onClick={onClose} type="button">
            <X size={19} />
          </button>
        </div>

        <div className="target-path">
          <span>精确目标</span>
          <strong>{task.merchantName} → {task.location} → {task.asset}</strong>
        </div>

        <section className="drawer-section">
          <span className="section-label">下一动作</span>
          <p className="next-action">{task.nextAction}</p>
          {task.blocker ? (
            <div className="blocker-note">
              <AlertTriangle size={16} />
              <span>{task.blocker}</span>
            </div>
          ) : null}
        </section>

        <dl className="state-grid">
          <div><dt>工作阶段</dt><dd>{task.workStage}</dd></div>
          <div><dt>执行状态</dt><dd>{task.executionState}</dd></div>
          <div><dt>证据状态</dt><dd>{task.evidenceState}</dd></div>
        </dl>

        <section className="drawer-section">
          <div className="section-heading">
            <span className="section-label">证据链</span>
            <span>{task.evidenceCount} 已具备</span>
          </div>
          <EvidenceRail task={task} />
          <div className="evidence-log">
            <div><Check size={14} /><span>资料来源已锁定</span><time>09:42</time></div>
            <div><Check size={14} /><span>变更预览已生成</span><time>10:08</time></div>
            <div className="current"><span className="pulse-dot" /><span>等待负责人授权</span><time>现在</time></div>
          </div>
        </section>

        <section className="drawer-section drawer-impact">
          <span className="section-label">预期影响</span>
          <p>{task.impact}</p>
        </section>

        <div className="drawer-actions">
          <button className="secondary-button" type="button">交给其他人</button>
          <button className="primary-button" type="button"><ShieldCheck size={16} /> 审阅发布预览</button>
        </div>
      </aside>
    </div>
  );
}

function Copilot({ merchantName, onClose }: { merchantName: string; onClose: () => void }) {
  const [previewReady, setPreviewReady] = useState(false);

  return (
    <aside className="copilot-panel" role="dialog" aria-modal="false" aria-label="SEO Ops Copilot">
      <div className="copilot-header">
        <div className="copilot-mark"><Sparkles size={17} /></div>
        <div><strong>SEO Ops Copilot</strong><span>商户 · {merchantName}</span></div>
        <button className="icon-button" aria-label="关闭 SEO Ops Copilot" onClick={onClose} type="button">
          <X size={17} />
        </button>
      </div>
      <div className="copilot-body">
        <div className="copilot-message">
          <span className="message-author">COPILOT</span>
          <p>我会沿用当前商户、门店和任务上下文。涉及发布、改价或第三方写入时，我只先生成预览。</p>
        </div>
        <div className="prompt-list">
          <button onClick={() => setPreviewReady(true)} type="button"><Zap size={14} /> 生成发布预览</button>
          <button type="button">总结当前阻塞</button>
          <button type="button">开始一次因果复盘</button>
        </div>
        {previewReady ? (
          <div className="preview-gate" role="status">
            <ShieldCheck size={17} />
            <div><strong>预览已就绪</strong><p>已生成预览：需要人工批准后才能执行外部写入。</p></div>
          </div>
        ) : null}
      </div>
      <div className="copilot-composer">
        <label htmlFor="copilot-input">给 Copilot 指令</label>
        <div>
          <input id="copilot-input" placeholder="例如：解释 UWS 为什么被阻塞" />
          <button aria-label="发送指令" type="button"><Command size={16} /></button>
        </div>
      </div>
      <button className="external-write" disabled type="button">执行外部写入</button>
    </aside>
  );
}

export default function App() {
  const [merchantId, setMerchantId] = useState("keke");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [merchantQuery, setMerchantQuery] = useState("");
  const [selectedTask, setSelectedTask] = useState<ExecutionTask | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [portfolioMode, setPortfolioMode] = useState(true);

  const merchant = merchants.find((item) => item.id === merchantId) ?? merchants[0];
  const filteredMerchants = useMemo(() => {
    const query = merchantQuery.trim().toLocaleLowerCase();
    return merchants.filter((item) =>
      `${item.name} ${item.location} ${item.service}`.toLocaleLowerCase().includes(query)
    );
  }, [merchantQuery]);
  const visibleTasks = portfolioMode ? tasks : tasks.filter((task) => task.merchantId === merchantId);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark" aria-label="Connexup SEO Ops">CX</div>
        <nav aria-label="主导航">
          {navigation.map(({ label, icon: Icon, active, badge }) => (
            <button className={active ? "active" : ""} key={label} title={label} type="button">
              <Icon size={18} /><span>{label}</span>{badge ? <small>{badge}</small> : null}
            </button>
          ))}
        </nav>
        <div className="operator-avatar" title="当前执行人：Xander">XA</div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="merchant-switcher">
            <button
              aria-expanded={switcherOpen}
              aria-label={`当前商户：${merchant.name}`}
              className="merchant-trigger"
              onClick={() => setSwitcherOpen((open) => !open)}
              type="button"
            >
              <span className={`merchant-avatar is-${merchant.health}`}>{merchant.shortName}</span>
              <span><small>当前工作上下文</small><strong>{merchant.name}</strong></span>
              <ChevronDown size={15} />
            </button>
            {switcherOpen ? (
              <div className="merchant-popover">
                <label className="merchant-search">
                  <Search size={15} />
                  <input
                    aria-label="搜索商户或门店"
                    autoFocus
                    onChange={(event) => setMerchantQuery(event.target.value)}
                    placeholder="搜索商户、门店或服务"
                    type="search"
                    value={merchantQuery}
                  />
                </label>
                <div className="merchant-list" role="listbox" aria-label="选择商户">
                  {filteredMerchants.map((item) => (
                    <button
                      aria-label={`${item.name} · ${item.location} · ${item.service}`}
                      aria-selected={item.id === merchantId}
                      key={item.id}
                      onClick={() => {
                        setMerchantId(item.id);
                        setPortfolioMode(false);
                        setSwitcherOpen(false);
                        setMerchantQuery("");
                      }}
                      role="option"
                      type="button"
                    >
                      <span className={`merchant-avatar is-${item.health}`}>{item.shortName}</span>
                      <span><strong>{item.name}</strong><small>{item.location} · {item.service}</small></span>
                      {item.id === merchantId ? <Check size={15} /> : null}
                    </button>
                  ))}
                </div>
                <div className="merchant-popover-footer"><span>{filteredMerchants.length} 个结果</span><kbd>⌘ K</kbd></div>
              </div>
            ) : null}
          </div>

          <div className="topbar-actions">
            <div className="run-health"><Activity size={14} /><span>Agent 正常</span><strong>4</strong></div>
            <button
              aria-label="打开 SEO Ops Copilot"
              className="copilot-trigger"
              onClick={() => setCopilotOpen(true)}
              type="button"
            ><Sparkles size={15} /> Copilot</button>
          </div>
        </header>

        <main className="main-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">EXECUTION CONTROL / 17 AUG 2026</span>
              <h1>{merchant.name}</h1>
              <p>{merchant.location} · {merchant.service}</p>
            </div>
            <div className="scope-toggle" aria-label="任务范围">
              <button className={portfolioMode ? "active" : ""} onClick={() => setPortfolioMode(true)} type="button">全部商户</button>
              <button className={!portfolioMode ? "active" : ""} onClick={() => setPortfolioMode(false)} type="button">当前商户</button>
            </div>
          </div>

          <section className="signal-strip" aria-label="今日执行摘要">
            <div><span>需要判断</span><strong>11</strong><small>3 项高影响</small></div>
            <div className="danger"><span>阻塞</span><strong>3</strong><small>最长 18 小时</small></div>
            <div><span>今天到期</span><strong>8</strong><small>完成 5 / 13</small></div>
            <div><span>回读缺口</span><strong>4</strong><small>禁止直接结项</small></div>
            <div className="capacity"><span>本周容量</span><strong>72%</strong><small><i style={{ width: "72%" }} /></small></div>
          </section>

          <div className="content-grid">
            <section className="queue-panel" aria-labelledby="action-inbox-title">
              <div className="panel-heading">
                <div><span className="eyebrow">ACTION INBOX</span><h2 id="action-inbox-title">行动队列</h2></div>
                <div className="view-tabs"><button className="active" type="button">行动队列</button><button type="button">工作包</button><button type="button">日历</button></div>
              </div>
              <div className="queue-groups">
                {bucketOrder.map((bucket) => {
                  const meta = bucketMeta[bucket];
                  const bucketTasks = visibleTasks.filter((task) => task.bucket === bucket);
                  if (bucketTasks.length === 0) return null;
                  return (
                    <section className={`queue-group tone-${meta.tone}`} key={bucket}>
                      <div className="group-heading">
                        <span className="group-signal" />
                        <div><h3>{meta.title}</h3><p>{meta.subtitle}</p></div>
                        <strong>{bucketTasks.length}</strong>
                      </div>
                      <div className="task-list">{bucketTasks.map((task) => <TaskRow key={task.id} onOpen={setSelectedTask} task={task} />)}</div>
                    </section>
                  );
                })}
              </div>
            </section>

            <aside className="context-column">
              <section className="context-card focus-card">
                <span className="eyebrow">TODAY'S FOCUS</span>
                <h2>先清 3 个判断点</h2>
                <p>它们会解除 7 个下游任务。不要从“今天执行”列表里随机开始。</p>
                <div className="focus-path"><span>3 判断</span><ChevronRight size={14} /><span>7 任务</span><ChevronRight size={14} /><span>2 上线</span></div>
              </section>
              <section className="context-card">
                <div className="card-title"><h3>异常信号</h3><AlertTriangle size={16} /></div>
                <div className="signal-item critical"><i /><div><strong>UWS Provider 回读失败</strong><span>已禁止自动重试 · 3h</span></div></div>
                <div className="signal-item"><i /><div><strong>Flushing 素材仍缺 4 项</strong><span>影响首页制作 · 6h</span></div></div>
              </section>
              <section className="context-card">
                <div className="card-title"><h3>最近运行</h3><Bot size={16} /></div>
                <div className="run-item"><span className="run-status success" /><div><strong>Website Audit</strong><small>Only Bear · 8m 12s</small></div><time>11:06</time></div>
                <div className="run-item"><span className="run-status failed" /><div><strong>GBP Readback</strong><small>Choice UWS · 1m 04s</small></div><time>10:52</time></div>
                <div className="run-item"><span className="run-status running" /><div><strong>Content Inventory</strong><small>可可小卤 · running</small></div><time>10:41</time></div>
              </section>
              <section className="context-card review-card">
                <div className="card-title"><h3>复盘与因果</h3><FolderKanban size={16} /></div>
                <p>本周 2 个显著变化等待归因，1 个实验已达到复盘窗口。</p>
                <button type="button">进入分析中心 <ChevronRight size={14} /></button>
              </section>
            </aside>
          </div>
        </main>
      </div>

      {selectedTask ? <TaskDrawer onClose={() => setSelectedTask(null)} task={selectedTask} /> : null}
      {copilotOpen ? <Copilot merchantName={merchant.name} onClose={() => setCopilotOpen(false)} /> : null}
      {!copilotOpen ? (
        <button className="floating-copilot" onClick={() => setCopilotOpen(true)} type="button"><MessageSquareText size={18} /><span>问 Copilot</span></button>
      ) : null}
    </div>
  );
}
