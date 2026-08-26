import { CheckCircle2, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { MerchantOnboardingView } from "../../api/types";

function slugify(displayName: string): string {
  const slug = displayName
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug !== "" ? slug : `m-${crypto.randomUUID().slice(0, 8)}`;
}

/** ＋ 新店：只提交一次接入事实。后端以确定性事件唤起 Planner，浏览器不再
 * 直接创建/发送问卷，避免和 Agent 任务图形成两条竞态链路。 */
export function NewMerchantModal({ onClose, onDone }: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<MerchantOnboardingView | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (displayName.trim() === "") return;
    setBusy(true);
    setError("");
    try {
      const merchant = await seoOpsApi.createMerchant({
        slug: slugify(displayName),
        display_name: displayName.trim(),
        ...(website.trim() !== "" ? { website: website.trim() } : {}),
        idempotency_key: `new-merchant-${crypto.randomUUID()}`,
      });
      setCreated(merchant);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "接入失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  return <div className="modal-layer" role="dialog" aria-modal="true" aria-label="新店接入">
    <div className="modal">
      <header><strong>新店接入</strong><button aria-label="关闭" onClick={onClose} type="button">✕</button></header>
      <div className="modal-body">
        {created ? <>
          <p style={{ margin: 0, color: "var(--teal)", fontSize: 11 }}>
            <CheckCircle2 size={13} style={{ verticalAlign: -2 }} /> {created.planner_enqueued
              ? "新店已进入任务编排"
              : "新店已登记，等待 Planner 配置"}
          </p>
          <p className="hint">{created.planner_enqueued
            ? <>Planner 已收到「{created.display_name}」的新店事件，将先生成问卷任务建议。运营采纳后由 Questionnaire Agent 生成站内问卷草稿；人工确认并登记发放后才会进入等待商家回复。</>
            : <>当前环境没有创建 Planner Task。请在「设置 → Agent 绑定」配置并发布 PLANNER Agent，然后重放该商户的新店接入事件。</>}</p>
          <button className="primary-button" onClick={onClose} style={{ width: "100%", marginTop: 12 }} type="button">完成</button>
        </> : <form onSubmit={submit}>
          <label>店名
            <input onChange={(e) => setDisplayName(e.target.value)} placeholder="例如：Only Bear Chicken & Boba" required type="text" value={displayName} />
          </label>
          <label>官网（可选，用于生成更准的问卷）
            <input onChange={(e) => setWebsite(e.target.value)} placeholder="https://" type="url" value={website} />
          </label>
          <button className="primary-button" disabled={busy} style={{ width: "100%" }} type="submit">
            <Plus size={14} /> {busy ? "创建中…" : "创建商户并生成任务计划"}
          </button>
          <p className="hint">只提交一次新店事实，由 Planner 生成问卷、关键词、审计和 Plan 的依赖任务图；不会在浏览器里直接发放问卷。</p>
          {error ? <p className="form-message" role="alert">{error}</p> : null}
        </form>}
      </div>
    </div>
  </div>;
}
