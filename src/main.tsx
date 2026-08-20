import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { QuestionnaireFormPage } from "./features/public/QuestionnaireFormPage";
import "./styles.css";

// /q/:slug 是商家公开填答页（第二用户面）：无账号、匿名可访问，不挂 AuthProvider。
const isPublicForm = window.location.pathname.startsWith("/seo-ops/q/");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename="/seo-ops">
      {isPublicForm ? <QuestionnaireFormPage /> : <AuthProvider><App /></AuthProvider>}
    </BrowserRouter>
  </StrictMode>
);
