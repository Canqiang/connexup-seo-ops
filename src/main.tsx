import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { isLoginPath } from "./auth/redirect";
import { LoginPage } from "./features/auth/LoginPage";
import { QuestionnaireFormPage } from "./features/public/QuestionnaireFormPage";
import "./styles.css";

// /q/:slug 是商家公开填答页（第二用户面）：无账号、匿名可访问，不挂 AuthProvider。
// 必须挂在 <Route path="q/:slug"> 下，QuestionnaireFormPage 里的 useParams 才拿得到 slug。
const isPublicForm = window.location.pathname.startsWith("/seo-ops/q/");
const isLogin = isLoginPath(window.location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename="/seo-ops">
      {isPublicForm
        ? <Routes><Route element={<QuestionnaireFormPage />} path="q/:slug" /></Routes>
        : isLogin ? <LoginPage /> : <AuthProvider><App /></AuthProvider>}
    </BrowserRouter>
  </StrictMode>
);
