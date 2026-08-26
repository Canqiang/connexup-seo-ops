import { Link, useNavigate } from "react-router-dom";
import type { HumanActionWire } from "../../api/types";
import { actionGroups, formatWaiting } from "./actionCopy";

export function ActionQueue({ items }: { items: HumanActionWire[] }) {
  const navigate = useNavigate();
  return <section aria-label="人工决策队列" className="action-queue">
    {actionGroups.map(({ key, label, description }) => {
      const groupItems = items.filter((item) => item.group === key);
      return <section className={`action-group group-${key.toLocaleLowerCase()}`} key={key}>
        <header><div><span className="eyebrow">{key === "EXCEPTION" ? "EXCEPTIONS" : key === "GATEKEEPING" ? "GATEKEEPING" : "MERCHANT CONTACT"}</span><h2>{label}</h2></div><p>{description}</p></header>
        <div className="action-rows">
          {groupItems.map((item) => <article aria-label={`${item.merchant_name} ${item.reason}`} className={`action-row group-${item.group.toLowerCase()}`} key={item.id}>
            <span aria-hidden className="decision-rail" />
            <div className="action-copy"><strong>{item.title}</strong><p>{item.reason}</p></div>
            <span className="merchant-context"><strong>{item.merchant_name}</strong>{item.location_name ? <small>{item.location_name}</small> : null}</span>
            <time dateTime={item.waiting_since}>{formatWaiting(item.waiting_since)}</time>
            {item.secondary_href ? <Link aria-label={`查看 ${item.merchant_name}`} className="action-secondary" to={item.secondary_href}>查看</Link> : null}
            <button className="action-primary" onClick={() => navigate(item.primary_action.href)} type="button">{item.primary_action.label}</button>
          </article>)}
          {!groupItems.length ? <p className="group-empty">当前没有{label}事项。</p> : null}
        </div>
      </section>;
    })}
  </section>;
}
