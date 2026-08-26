import { useEffect } from "react";

const SUFFIX = "Connexup SEO Ops";

/** 每页设置浏览器标签标题；卸载时不复位（下一页会覆盖）。 */
export function usePageTitle(title?: string): void {
  useEffect(() => {
    document.title = title ? `${title} · ${SUFFIX}` : SUFFIX;
  }, [title]);
}
