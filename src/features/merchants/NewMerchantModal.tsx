import { CheckCircle2, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { QuestionnaireView } from "../../api/types";

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

/** ＋ 新店：唯一新建入口。店名/官网 → 建商户 → 生成问卷 → 发放。
 * 外发链接是站内公填页（/q/:slug），发放渠道（短信/邮件）在系统外。 */
export function NewMerchantModal({ onClose, onDone }: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<QuestionnaireView | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (displayName.trim() === "") return;
    setBusy(true);
    setError("");
    try {
      const merchant = await seoOpsApi.createMerchant({
        slug: slugify(displayName),
        display_name: displayName.trim(),
        idempotency_key: `new-merchant-${crypto.randomUUID()}`,
      });
      const questionnaire = await seoOpsApi.createQuestionnaire(merchant.id, {
        ...(website.trim() !== "" ? { website: website.trim() } : {}),
        idempotency_key: `new-questionnaire-${crypto.randomUUID()}`,
      });
      const sent = await seoOpsApi.sendQuestionnaire(questionnaire.id);
      setCreated(sent);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "接入失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const publicUrl = created
    ? `${window.location.origin}/q/${created.share_slug}`
    : "";

  return <div className="modal-layer" role="dialog" aria-modal="true" aria-label="新店接入">
    <div className="modal">
      <header><strong>新店接入</strong><button aria-label="关闭" onClick={onClose} type="button">✕</button></header>
      <div className="modal-body">
        {created ? <>
          <p style={{ margin: 0, color: "var(--teal)", fontSize: 11 }}>
            <CheckCircle2 size={13} style={{ verticalAlign: -2 }} /> 问卷已生成并发放登记（{created.questions.length} 题）
          </p>
          <div className="link-out">
            <span>{publicUrl}</span>
            <button className="text-button" onClick={() => { void navigator.clipboard?.writeText(publicUrl); }} type="button">复制</button>
          </div>
          <p className="hint">把链接发给商家（短信/邮件在系统外）。发放后该商户进入首页「等待商家回复」组，按发出天数排序、可重发；商家提交后自动进入关键词阶段。</p>
          <button className="primary-button" onClick={onClose} style={{ width: "100%", marginTop: 12 }} type="button">完成</button>
        </> : <form onSubmit={submit}>
          <label>店名
            <input onChange={(e) => setDisplayName(e.target.value)} placeholder="例如：Only Bear Chicken & Boba" required type="text" value={displayName} />
          </label>
          <label>官网（可选，用于生成更准的问卷）
            <input onChange={(e) => setWebsite(e.target.value)} placeholder="https://" type="url" value={website} />
          </label>
          <button className="primary-button" disabled={busy} style={{ width: "100%" }} type="submit">
            <Plus size={14} /> {busy ? "生成中…" : "生成接入问卷并登记发放"}
          </button>
          <p className="hint">基于店名/官网生成定制问卷（业务描述、服务方式、覆盖范围…）。问卷只读采集商家信息，不涉及任何外部写入。</p>
          {error ? <p className="form-message" role="alert">{error}</p> : null}
        </form>}
      </div>
    </div>
  </div>;
}
