import { useEffect } from "react";
import { Route, Routes, useLocation, useOutletContext } from "react-router-dom";
import { AppShell } from "./app/AppShell";
import { RouteErrorPage } from "./app/RouteErrorPage";
import type { ViewMode } from "./app/viewMode";
import { InboxPage } from "./features/inbox/InboxPage";
import { MerchantWorkspacePage } from "./features/merchant/MerchantWorkspacePage";
import { PostPlanPage } from "./features/merchant/PostPlanPage";
import { MerchantsPage } from "./features/merchants/MerchantsPage";
import { OverviewPage } from "./features/overview/OverviewPage";
import { ReportsPage } from "./features/reports/ReportsPage";
import { ReviewsPage } from "./features/reviews/ReviewsPage";
import { RunsPage } from "./features/runs/RunsPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { TaskPage } from "./features/tasks/TaskPage";
import { WorkbenchPage } from "./features/workbench/WorkbenchPage";
import { WorkspaceProvider } from "./workspace/WorkspaceContext";

/** 路由切换回到页顶：详情页往返不带走上一页的滚动位置。 */
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

function HomePage() {
  const { mode } = useOutletContext<{ mode: ViewMode }>();
  return mode === "audit" ? <OverviewPage /> : <WorkbenchPage />;
}

export default function App() {
  return <WorkspaceProvider><ScrollToTop /><Routes><Route element={<AppShell />}>
    <Route index element={<HomePage />} />
    <Route path="merchants" element={<MerchantsPage />} />
    <Route path="inbox" element={<InboxPage />} />
    <Route path="merchants/:merchantId" element={<MerchantWorkspacePage />} />
    <Route path="merchants/:merchantId/post-plan" element={<PostPlanPage />} />
    <Route path="tasks/:taskId" element={<TaskPage />} />
    <Route path="runs" element={<RunsPage />} />
    <Route path="reviews" element={<ReviewsPage />} />
    <Route path="reports" element={<ReportsPage />} />
    <Route path="settings" element={<SettingsPage />} />
    <Route path="*" element={<RouteErrorPage />} />
  </Route></Routes></WorkspaceProvider>;
}
