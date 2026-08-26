import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";

/** 详情页返回：有浏览历史就 navigate(-1)（保住来源页的筛选/滚动），
 * 深链直达（历史栈为空）时退到 fallback 列表页。 */
export function BackButton({ fallback, label = "返回" }: { fallback: string; label?: string }) {
  const navigate = useNavigate();
  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(fallback);
  };
  return <button aria-label={label} className="back-button" onClick={goBack} type="button">
    <ArrowLeft size={14} /> {label}
  </button>;
}
