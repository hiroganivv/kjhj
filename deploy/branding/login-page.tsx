"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { auth } from "@/lib/auth";

const FEATURES = ["SpringBoot", "Mybatis", "Shiro", "Thymeleaf", "Bootstrap"];

const S: Record<string, React.CSSProperties> = {
  wrap: {
    position: "relative", minHeight: "100vh", width: "100%", overflow: "hidden",
    background: "#c9d4b8 url(/login-background.jpg) center center / cover no-repeat",
    fontFamily: '"Helvetica Neue",Helvetica,Arial,"Microsoft YaHei",sans-serif',
  },
  panel: { width: "1000px", maxWidth: "94%", margin: "0 auto", display: "flex", alignItems: "center", minHeight: "100vh" },
  left: { width: "58%", textAlign: "center", padding: "0 20px", color: "#1f7a8c" },
  logo: { display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 26, fontWeight: 600, marginBottom: 24 },
  logoImg: { maxWidth: 180, maxHeight: 70 },
  welcome: { fontSize: 20, fontWeight: 400, color: "#fff", textShadow: "0 1px 3px rgba(0,0,0,.3)" },
  list: { listStyle: "none", padding: 0, margin: "18px 0 0", display: "inline-block", textAlign: "left" },
  li: { fontSize: 14, lineHeight: 2, color: "#eef4f8", textShadow: "0 1px 2px rgba(0,0,0,.2)" },
  arrow: { color: "#1ab394", marginRight: 8 },
  right: { width: "42%", padding: "0 10px", alignSelf: "center" },
  form: {
    display: "block", width: "100%", height: "auto", alignSelf: "center", boxSizing: "border-box",
    background: "rgba(255,255,255,.30)", padding: "22px 26px", borderRadius: 4,
    border: "1px solid rgba(255,255,255,.55)", boxShadow: "0 8px 30px rgba(0,0,0,.12)",
  },
  h4: { fontSize: 16, color: "#333", margin: "0 0 4px" },
  sub: { fontSize: 12, color: "#666", margin: "0 0 18px" },
  field: { position: "relative", marginBottom: 14 },
  input: {
    display: "block", width: "100%", height: 36, boxSizing: "border-box",
    padding: "6px 34px 6px 10px", fontSize: 14, color: "#333",
    background: "#fff", border: "1px solid #ccc", borderRadius: 4, outline: "none",
  },
  ico: {
    position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
    display: "inline-flex", width: 16, height: 16, color: "#888", pointerEvents: "none",
  },
  captchaRow: { display: "flex", gap: 10, marginBottom: 14 },
  captchaInput: {
    flex: 1, width: "100%", height: 36, boxSizing: "border-box", padding: "6px 10px",
    fontSize: 14, color: "#333", background: "#fff", border: "1px solid #ccc",
    borderRadius: 4, outline: "none",
  },
  captchaImg: { height: 36, width: 100, objectFit: "cover", border: "1px solid #ccc", borderRadius: 4, cursor: "pointer", background: "#fff" },
  remember: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#555", margin: "4px 0 14px" },
  err: { color: "#c9302c", fontSize: 12, margin: "0 0 10px" },
  submit: {
    display: "block", width: "100%", height: 36, border: "none", borderRadius: 4,
    background: "#1ab394", color: "#fff", fontSize: 14, cursor: "pointer",
  },
  footer: {
    position: "absolute", left: 0, right: 0, bottom: 28, textAlign: "center",
    color: "rgba(255,255,255,.9)", fontSize: 12, textShadow: "0 1px 3px rgba(0,0,0,.25)",
  },
};

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const token = auth.getToken();
    if (token) {
      auth.setToken(token);
      window.location.replace("/function/tasks");
      return;
    }
    api.authStatus()
      .then(({ initialized }) => { if (!initialized) router.replace("/setup"); })
      .catch(() => setError(""))
      .finally(() => setChecking(false));
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;
    setLoading(true);
    setError("");
    try {
      const { token } = await api.login("noreply", password);
      auth.setToken(token);
      window.location.replace("/function/tasks");
    } catch (err) {
      const e2 = err as Error & { status?: number };
      if (e2.status === 429) setError("尝试过于频繁，账号已临时锁定，请稍后再试");
      else if (e2.status === 401) setError("用户名或密码错误");
      else if (e2.status === 403) setError("密码尚未初始化，请先完成首次设置");
      else setError(e2.message || "登录失败，请稍后再试");
    } finally {
      setLoading(false);
    }
  }

  if (checking) return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>正在加载…</div>;

  return (
    <div className="signin" style={S.wrap}>
      <div className="signinpanel" style={S.panel}>
        <div className="row" style={{ display: "flex", width: "100%" }}>
          <div className="col-sm-7" style={S.left}>
            <div className="logopanel m-b" style={S.logo}>
              <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
                <img alt="[ 若依 ]" src="/ruoyi.png" style={S.logoImg} />
              </h1>
            </div>
            <div className="m-b" />
            <h4 style={S.welcome}>欢迎使用 <strong>若依 后台管理系统</strong></h4>
            <ul className="m-b" style={S.list}>
              {FEATURES.map((f) => (
                <li key={f} style={S.li}><i className="fa fa-arrow-circle-o-right m-r-xs" style={S.arrow} />{f}</li>
              ))}
            </ul>
          </div>
          <div className="col-sm-5" style={S.right}>
            <form id="signupForm" autoComplete="off" onSubmit={handleSubmit} style={S.form}>
              <h4 className="no-margins" style={S.h4}>登录：</h4>
              <p className="m-t-md" style={S.sub}>你若不离不弃，我必生死相依</p>
              <div style={S.field}>
                <input type="text" name="username" className="form-control uname" placeholder="用户名" value="noreply" readOnly aria-label="用户名" style={S.input} />
                <span style={S.ico} aria-hidden>👤</span>
              </div>
              <div style={S.field}>
                <input type="password" name="password" className="form-control pword" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" aria-label="密码" style={S.input} />
                <span style={S.ico} aria-hidden>🔒</span>
              </div>
              <div className="row m-t" style={S.captchaRow}>
                <input type="text" name="validateCode" className="form-control code" placeholder="验证码" maxLength={5} aria-label="验证码" style={S.captchaInput} />
                <a href="javascript:void(0);" title="点击更换验证码" style={{ flex: "none" }}>
                  <img src="/captcha/captchaImage?type=math" className="imgcode" style={S.captchaImg} alt="验证码" />
                </a>
              </div>
              <div className="checkbox-custom" style={S.remember}>
                <input type="checkbox" id="rememberme" name="rememberme" defaultChecked style={{ width: 14, height: 14, margin: 0 }} />
                <label htmlFor="rememberme" style={{ fontSize: 13 }}>记住我</label>
              </div>
              {error && <p style={S.err}>{error}</p>}
              <button className="btn btn-success btn-block" id="btnSubmit" type="submit" disabled={loading || !password} style={{ ...S.submit, opacity: loading || !password ? 0.7 : 1 }}>
                {loading ? "正在验证登录，请稍候..." : "登录"}
              </button>
            </form>
          </div>
        </div>
        <div className="signup-footer" style={S.footer}>
          <div className="pull-left">Copyright &copy; 2018-2026 ruoyi.vip All Rights Reserved. <br /></div>
        </div>
      </div>
    </div>
  );
}
