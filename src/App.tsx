import { Route, Routes } from "react-router-dom";
import { AppShell } from "./app/AppShell";
import { RouteErrorPage } from "./app/RouteErrorPage";
import { InboxPage } from "./features/inbox/InboxPage";
import { MerchantWorkspacePage } from "./features/merchant/MerchantWorkspacePage";
import { PortfolioPage } from "./features/portfolio/PortfolioPage";
import { ReportsPage } from "./features/reports/ReportsPage";
import { ReviewsPage } from "./features/reviews/ReviewsPage";
import { TaskPage } from "./features/tasks/TaskPage";
import { WorkspaceProvider } from "./workspace/WorkspaceContext";

export default function App() {
  return <WorkspaceProvider><Routes><Route element={<AppShell />}>
    <Route index element={<PortfolioPage />} />
    <Route path="inbox" element={<InboxPage />} />
    <Route path="merchants/:merchantId" element={<MerchantWorkspacePage />} />
    <Route path="tasks/:taskId" element={<TaskPage />} />
    <Route path="reviews" element={<ReviewsPage />} />
    <Route path="reports" element={<ReportsPage />} />
    <Route path="*" element={<RouteErrorPage />} />
  </Route></Routes></WorkspaceProvider>;
}
