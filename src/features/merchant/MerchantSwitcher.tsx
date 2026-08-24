import { Check, ChevronDown, Search, Star } from "lucide-react";
import { useMemo, useState } from "react";
import type { MerchantSummary } from "../../api/types";

type Props = {
  merchants: MerchantSummary[];
  currentId?: string;
  onPortfolio: () => void;
  onSelect: (id: string) => void;
};

export function MerchantSwitcher({ merchants, currentId, onPortfolio, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>([]);
  const current = merchants.find((item) => item.id === currentId);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return merchants.filter((merchant) => [
      merchant.display_name,
      merchant.slug,
      ...merchant.locations.map((location) => location.display_name),
      ...merchant.operators.map((operator) => operator.name)
    ].join(" ").toLocaleLowerCase().includes(normalized))
      .sort((a, b) => Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)));
  }, [favorites, merchants, query]);

  const toggleFavorite = (id: string) => {
    const next = favorites.includes(id) ? favorites.filter((value) => value !== id) : [...favorites, id];
    setFavorites(next);
  };
  return (
    <div className="merchant-switcher" onKeyDown={(event) => {
      if (event.key === "Escape") setOpen(false);
    }}>
      <button
        aria-controls="merchant-options"
        aria-expanded={open}
        aria-label={current ? `当前商户：${current.display_name}` : "选择商户工作范围"}
        className="merchant-trigger"
        onClick={() => setOpen((value) => !value)}
        role="combobox"
        type="button"
      >
        <span className={`merchant-avatar is-${current?.health.toLocaleLowerCase() ?? "portfolio"}`}>
          {current ? initials(current.display_name) : "ALL"}
        </span>
        <span><small>当前工作范围</small><strong>{current?.display_name ?? "全部商户"}</strong></span>
        <ChevronDown size={15} />
      </button>
      {open ? (
        <div className="merchant-popover">
          <label className="merchant-search"><Search size={15} /><input
            aria-label="搜索商户、门店或负责人"
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            placeholder="商户 / 门店 / 负责人"
            type="search"
            value={query}
          /></label>
          <div className="merchant-list" id="merchant-options" role="listbox" aria-label="商户结果">
            <button aria-selected={!currentId} onClick={() => { onPortfolio(); setOpen(false); }} role="option" type="button">
              <span className="merchant-avatar is-portfolio">ALL</span><span><strong>全部商户</strong><small>组合级风险与容量</small></span>
              {!currentId ? <Check size={15} /> : null}
            </button>
            {filtered.map((merchant) => (
              <div className="merchant-option" key={merchant.id}>
                <button
                  aria-label={`${merchant.display_name}，${merchant.blocked_count} 个阻塞`}
                  aria-selected={merchant.id === currentId}
                  onClick={() => { onSelect(merchant.id); setOpen(false); setQuery(""); }}
                  role="option"
                  type="button"
                >
                  <span className={`merchant-avatar is-${merchant.health.toLocaleLowerCase()}`}>{initials(merchant.display_name)}</span>
                  <span><strong>{merchant.display_name}</strong><small>{merchant.location_count} 地点 · {merchant.task_count} 任务 · {merchant.blocked_count} 阻塞</small></span>
                  {merchant.id === currentId ? <Check size={15} /> : null}
                </button>
                <button aria-label={`${favorites.includes(merchant.id) ? "取消收藏" : "收藏"} ${merchant.display_name}`} className="favorite-button" onClick={() => toggleFavorite(merchant.id)} type="button">
                  <Star fill={favorites.includes(merchant.id) ? "currentColor" : "none"} size={13} />
                </button>
              </div>
            ))}
          </div>
          <div className="merchant-popover-footer"><span>{filtered.length} 个结果</span><kbd>Esc</kbd></div>
        </div>
      ) : null}
    </div>
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  return (words.length > 1 ? words.slice(0, 2).map((word) => word[0]).join("") : name.slice(0, 2)).toLocaleUpperCase();
}
