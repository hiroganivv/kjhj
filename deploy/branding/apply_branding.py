"""在 CI checkout 的 源码上应用"若依风格"登录页伪装补丁（幂等）。

改动点：
  1) server/auth.go：用户名校验接受 noreply。
  2) (auth)/login/page.tsx：整文件替换为若依 DOM 结构（用户名 noreply，保留真实登录逻辑）。
  3) (external)/page.tsx：整文件替换，去掉「正在进入工作台…」splash（无 token 直接去 /login）。
  4) (auth)/layout.tsx + app-config.ts：title -> 登录握奇系统。
  5) 根 layout：仅 html lang=zh（若依 CSS/JS 只由 login-static.html 加载，绝不注入根 layout）。
  6) 复制 ruoyi-assets/ 整棵树到 web/public/（css/js/png/验证码占位）。
  7) favicon.ico / login-background.jpg 覆盖。

用法：
  python3 apply_branding.py --src <源码目录> --assets <本脚本所在目录>
"""
import argparse
import shutil
import sys
from pathlib import Path


def log(msg: str) -> None:
    print(f"[branding] {msg}")


def replace_in_file(path: Path, old: str, new: str, required: bool = True) -> bool:
    if not path.exists():
        log(f"WARN 文件不存在: {path}")
        return False
    text = path.read_text(encoding="utf-8")
    if old in text:
        path.write_text(text.replace(old, new), encoding="utf-8")
        log(f"OK  patched {path.name}")
        return True
    if new in text:
        log(f"SKIP 已是目标状态: {path.name}")
        return True
    if required:
        log(f"ERROR 未找到待替换内容: {path}")
        sys.exit(1)
    return False


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="源码根目录")
    ap.add_argument("--assets", required=True, help="补丁资产目录")
    args = ap.parse_args()

    src = Path(args.src)
    assets = Path(args.assets)
    if not src.is_dir():
        log(f"ERROR 源码目录不存在: {src}")
        sys.exit(1)

    _u = "PO" + "JUN"
    _a = "AR" + "TEX"
    _auth_old = 'if req.Username != "' + _u + '" && req.Username != "' + _a + '"'
    _auth_new = 'if req.Username != "noreply" && req.Username != "' + _u + '" && req.Username != "' + _a + '"'
    replace_in_file(
        src / "server" / "auth.go",
        _auth_old,
        _auth_new,
    )

    login_page = src / "web" / "src" / "app" / "(auth)" / "login" / "page.tsx"
    if not login_page.exists():
        log(f"ERROR 登录页不存在: {login_page}")
        sys.exit(1)
    shutil.copyfile(assets / "login-page.tsx", login_page)
    log("OK  登录页 -> 若依 DOM 结构（noreply）")

    root_page = src / "web" / "src" / "app" / "(external)" / "page.tsx"
    if root_page.exists() and (assets / "root-page.tsx").exists():
        shutil.copyfile(assets / "root-page.tsx", root_page)
        log("OK  根路由已替换（去掉「正在进入工作台…」）")
    else:
        log("WARN 根路由文件不存在，跳过 splash 移除")

    main_layout = src / "web" / "src" / "app" / "(main)" / "layout.tsx"
    if main_layout.exists() and (assets / "main-layout.tsx").exists():
        shutil.copyfile(assets / "main-layout.tsx", main_layout)
        log("OK  (main)/layout.tsx 已替换（auth gate 防偶发白屏）")
    else:
        log("WARN (main)/layout.tsx 或补丁不存在，跳过")

    replace_in_file(src / "web" / "src" / "app" / "(auth)" / "layout.tsx",
                    'title: "Console"', 'title: "登录握奇系统"', required=False)
    replace_in_file(src / "web" / "src" / "app" / "(auth)" / "layout.tsx",
                    'title: "登录-县域管理平台"', 'title: "登录握奇系统"', required=False)
    replace_in_file(src / "web" / "src" / "config" / "app-config.ts",
                    'title: "Console"', 'title: "登录握奇系统"', required=False)

    root_layout = src / "web" / "src" / "app" / "layout.tsx"
    if root_layout.exists():
        text = root_layout.read_text(encoding="utf-8")
        changed = False
        if 'lang="en"' in text:
            text = text.replace('lang="en"', 'lang="zh"', 1)
            changed = True
            log("OK  html lang -> zh")
        if changed:
            root_layout.write_text(text, encoding="utf-8")
        else:
            log("SKIP 根 layout 已是目标状态")
    else:
        log("ERROR 根 layout 不存在")
        sys.exit(1)

    asset_tree = assets / "ruoyi-assets"
    if asset_tree.is_dir():
        public = src / "web" / "public"
        public.mkdir(parents=True, exist_ok=True)
        count = 0
        for f in asset_tree.rglob("*"):
            if f.is_file():
                rel = f.relative_to(asset_tree)
                target = public / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(f, target)
                count += 1
        log(f"OK  已复制 {count} 个若依伪装资源到 web/public/")
    else:
        log("WARN 缺少 ruoyi-assets 目录")

    favicon_src = assets / "favicon.ico"
    if favicon_src.exists():
        for rel in ("web/public/favicon.ico", "web/src/app/favicon.ico"):
            target = src / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(favicon_src, target)
        log("OK  favicon 已覆盖")
    bg_src = assets / "login-background.jpg"
    if bg_src.exists():
        target = src / "web" / "public" / "login-background.jpg"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(bg_src, target)
        log("OK  背景图已覆盖")

    log("完成。")


if __name__ == "__main__":
    main()
