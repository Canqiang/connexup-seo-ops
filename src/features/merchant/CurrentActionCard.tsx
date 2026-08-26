import { Link } from "react-router-dom";

export interface MerchantNextAction {
  title: string;
  consequence: string;
  actionLabel: string;
  action: { label: string; href?: string; disabled?: boolean; onClick?: () => void };
}

export function CurrentActionCard({ action, error }: { action: MerchantNextAction; error?: string }) {
  const primary = action.action.href ? <Link className="primary-button" to={action.action.href}>{action.action.label}</Link> : <button className="primary-button" disabled={action.action.disabled} onClick={action.action.onClick} type="button">{action.action.label}</button>;
  return <section aria-label="当前动作" className="current-action-card"><span className="eyebrow">CURRENT ACTION · 一项动作</span><h2>{action.title}</h2><p>{action.consequence}</p><div className="current-action-primary">{primary}</div>{error ? <p className="form-message" role="alert">{error}</p> : null}</section>;
}
