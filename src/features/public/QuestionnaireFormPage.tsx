import { CheckCircle2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { QuestionnaireItemWire } from "../../api/types";
import { useResource } from "../../hooks/useResource";

/** 商家公开填答页（/q/:slug）——系统的第二用户面：无账号、无导航、只收这一次问卷。
 * 匿名可访问：main.tsx 在此路径下不挂 AuthProvider。 */
export function QuestionnaireFormPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const form = useResource((signal) => seoOpsApi.questionnaireForm(slug, signal), [slug]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  if (form.loading) return <Shell><div className="public-card" role="status">正在打开问卷…</div></Shell>;
  if (form.error) return <Shell><div className="public-card is-error" role="alert">
    <h1>链接无效或已关闭</h1>
    <p>请向对接的运营确认最新问卷链接。</p>
  </div></Shell>;
  const data = form.data;
  if (!data) return null;

  if (submitted || data.status === "FILLED") return <Shell><div className="public-card is-done">
    <CheckCircle2 size={28} />
    <h1>已收到，感谢配合！</h1>
    <p>{data.merchant_name} 的信息已提交。我们会基于这些内容准备关键词与优化方案，后续进展由运营同步。</p>
  </div></Shell>;

  if (data.status === "DRAFT") return <Shell><div className="public-card">
    <h1>问卷尚未开放</h1>
    <p>这份问卷还没有正式发出。请联系对接的运营获取有效链接。</p>
  </div></Shell>;

  const questions = data.questions ?? [];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await seoOpsApi.submitQuestionnaire(slug, answers);
      setSubmitted(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "提交失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  return <Shell><form className="public-card" onSubmit={(event) => { void submit(event); }}>
    <header>
      <span className="eyebrow">{data.merchant_name} · 接入问卷</span>
      <h1>帮我们更懂你的生意</h1>
      <p>约 10 分钟。回答会用于制定本地 SEO 方案（关键词、Google 商家资料、网站优化）。不知道的题可填「不知道」，不要留空猜。</p>
    </header>
    <ol className="public-q">
      {questions.map((question, index) => <QuestionField
        answer={answers[question.id] ?? ""}
        index={index}
        key={question.id}
        onAnswer={(value) => setAnswers((prev) => ({ ...prev, [question.id]: value }))}
        question={question}
      />)}
    </ol>
    <button className="primary-button" disabled={busy} type="submit">{busy ? "提交中…" : "提交问卷"}</button>
    <p className="hint">提交后问卷即刻关闭，同一链接不能重复填写；需要修改请联系运营。</p>
    {error ? <p className="form-message" role="alert">{error}</p> : null}
  </form></Shell>;
}

function QuestionField({ question, index, answer, onAnswer }: {
  question: QuestionnaireItemWire;
  index: number;
  answer: string;
  onAnswer: (value: string) => void;
}) {
  return <li>
    <label htmlFor={`q-${question.id}`}>
      <span className="q-title">{index + 1}. {question.question}{question.required ? <em className="q-required"> *必填</em> : null}</span>
      {question.hint ? <small>{question.hint}</small> : null}
    </label>
    <textarea
      id={`q-${question.id}`}
      onChange={(event) => onAnswer(event.target.value)}
      placeholder={question.required ? "请填写…" : "选填"}
      rows={question.question.length > 30 ? 4 : 2}
      value={answer}
    />
  </li>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="public-page"><main>{children}</main></div>;
}
