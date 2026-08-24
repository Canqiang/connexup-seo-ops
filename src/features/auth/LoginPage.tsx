import { useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import { authApi } from "../../api/authApi";
import { navigateTo, safeReturnTo } from "../../auth/redirect";

export function LoginPage() {
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await authApi.login(email, password);
      setPassword("");
      const returnTo = new URLSearchParams(location.search).get("return_to");
      navigateTo(safeReturnTo(returnTo));
    } catch {
      setError("邮箱或密码不正确，请重试。");
    } finally {
      setBusy(false);
    }
  };

  return <div className="login-page"><main className="login-layout">
    <section className="login-main" aria-labelledby="login-title">
      <p className="login-kicker">CONNEXUP · INTERNAL WORKSPACE</p>
      <h1 id="login-title">登录 SEO Ops</h1>
      <p className="login-intro">使用你的内部运营身份进入受控的商户工作空间。</p>
      <form className="login-form" onSubmit={(event) => { void submit(event); }}>
        <label htmlFor="login-email">工作邮箱</label>
        <input autoComplete="email" id="login-email" name="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
        <label htmlFor="login-password">密码</label>
        <input autoComplete="current-password" id="login-password" name="password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
        {error ? <p className="login-error" role="alert">{error}</p> : null}
        <button className="login-submit" disabled={busy} type="submit">{busy ? "正在确认…" : "登录 SEO Ops"}</button>
      </form>
    </section>
    <aside className="login-assurance" aria-label="SEO Ops 访问控制说明">
      <p className="login-kicker">ACCESS CONTROL</p>
      <h2>从身份确认，到可审计的运营范围。</h2>
      <ol className="control-line">
        <li><span>01</span><strong>身份</strong><small>确认内部操作员会话</small></li>
        <li><span>02</span><strong>商户范围</strong><small>由服务端会话限定工作对象</small></li>
        <li><span>03</span><strong>审计</strong><small>在获准范围内留存运营记录</small></li>
      </ol>
      <p className="login-assurance-note">登录不授予额外权限；商户范围和审计能力均由服务端会话决定。</p>
    </aside>
  </main></div>;
}
