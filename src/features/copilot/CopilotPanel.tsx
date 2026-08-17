import { Bot, Command, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import { sessionApi, type StreamEvent } from "../../api/sessionApi";
import type { RuntimeConfig } from "../../api/types";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import { buildCopilotMessage, type CopilotScope } from "./copilotContext";

export function CopilotPanel({ config, onClose }: { config: RuntimeConfig; onClose: () => void }) {
  const location = useLocation();
  const workspace = useWorkspace();
  const taskId = location.pathname.match(/^\/tasks\/([^/]+)/)?.[1];
  const [sessionId, setSessionId] = useState<string>();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState("等待提问");
  const [busy, setBusy] = useState(false);
  const streamRef = useRef<AbortController | undefined>(undefined);
  const scope: CopilotScope = taskId ? { kind: "task", merchant_id: workspace.merchantId, task_id: taskId }
    : workspace.merchant ? { kind: "merchant", merchant_id: workspace.merchant.id, merchant_name: workspace.merchant.display_name }
    : { kind: "portfolio", blockers: workspace.portfolio?.totals.blocked, overdue: workspace.portfolio?.totals.overdue };
  useEffect(() => () => streamRef.current?.abort(), []);

  const ensureSession = async () => {
    if (sessionId) return sessionId;
    if (!config.copilot_agent_id) throw new Error("Copilot agent missing");
    const created = await sessionApi.createSession(config.copilot_agent_id);
    if ((created.loaded_tools?.length ?? 0) || (created.loaded_skills?.length ?? 0) || (created.loaded_sub_agents?.length ?? 0)) {
      await sessionApi.closeSession(created.sessionId);
      throw new Error("Copilot safety boundary triggered");
    }
    if (taskId) {
      try {
        const task = await seoOpsApi.task(taskId);
        await seoOpsApi.linkConversation(taskId, { conversation_id: created.sessionId, expected_state_version: task.state_version, idempotency_key: crypto.randomUUID() });
        await seoOpsApi.task(taskId);
      } catch { setStatus("对话可用，但任务审计链接未完成。"); }
    }
    setSessionId(created.sessionId);
    return created.sessionId;
  };
  const send = async () => {
    if (!question.trim() || busy) return;
    setBusy(true); setAnswer(""); setStatus("正在分析只读上下文…");
    try {
      const id = await ensureSession();
      const message = buildCopilotMessage(scope, question);
      streamRef.current = sessionApi.streamMessage(id, message, {
        onEvent: (event) => handleEvent(event), onError: () => { setStatus("Copilot 连接失败"); setBusy(false); },
        onClose: () => setBusy(false)
      });
    } catch (error) { setStatus(error instanceof Error ? error.message : "Copilot 启动失败"); setBusy(false); }
  };
  const handleEvent = (event: StreamEvent) => {
    if (["tool_start", "tool_result", "tool_approval_request", "approval_request"].includes(event.type)) {
      streamRef.current?.abort(); setStatus("Copilot safety boundary triggered"); setBusy(false); return;
    }
    if (event.type === "text_chunk" && event.content) setAnswer((value) => value + event.content);
    else if (event.type === "turn_complete") {
      if (event.output) setAnswer((value) => value || event.output || "");
      setStatus("分析完成"); setBusy(false);
    }
    else if (event.type === "status_change" && event.status) setStatus(event.status);
    else if (event.type === "error") { setStatus(event.message ?? "Copilot error"); setBusy(false); }
  };
  return <aside aria-label="SEO Ops Copilot" aria-modal="false" className="copilot-panel" role="dialog"><header className="copilot-header"><span className="copilot-mark"><Bot size={17} /></span><div><strong>SEO Ops Copilot</strong><small>{scope.kind} · {workspace.merchant?.display_name ?? "全部商户"}</small></div><button aria-label="关闭 Copilot" className="icon-button" onClick={onClose}><X size={17} /></button></header>
    <div className="copilot-boundary"><ShieldCheck size={15} /><p>只读分析。无工具、无记忆、无外部写入，也不能代替正式审批。</p></div><div className="copilot-body">{answer ? <div className="copilot-answer">{answer}</div> : <div className="copilot-empty"><strong>从当前上下文开始</strong><p>可询问阻塞原因、证据缺口或复盘结构。</p></div>}<span className="copilot-status" role="status">{status}</span></div>
    <div className="copilot-composer"><label htmlFor="copilot-question">给 Copilot 的问题</label><div><textarea id="copilot-question" maxLength={28000} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：哪些阻塞最值得今天先处理？" value={question} /><button aria-label="发送问题" disabled={busy || !question.trim()} onClick={send} type="button"><Command size={16} /></button></div></div><button className="external-write" disabled>执行外部写入（MVP 禁用）</button>
  </aside>;
}
