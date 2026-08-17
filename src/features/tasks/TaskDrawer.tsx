import { X } from "lucide-react";
import type { ReactNode } from "react";

export function TaskDrawer({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <div className="drawer-layer"><button aria-label="关闭任务面板" className="drawer-backdrop" onClick={onClose} type="button" /><aside aria-label={title} aria-modal="true" className="task-drawer" role="dialog"><header className="drawer-header"><h2>{title}</h2><button aria-label="关闭" className="icon-button" onClick={onClose}><X size={18} /></button></header>{children}</aside></div>;
}
