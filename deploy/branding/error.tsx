"use client";

import * as React from "react";

import Link from "next/link";

import { CircleAlertIcon, RotateCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

// 路由级错误边界。
//
// 之前没有 error.tsx：任何客户端异常（旧 WebView 不支持某个 API、后端返回了
// 意料外的结构、某处渲染抛错）都只会变成 Next 默认的
// "Application error: a client-side exception has occurred"，用户看不到原因，
// 排查只能靠猜。这里把 message / stack 前几行直接显示出来——手机上一眼能截图，
// 也比白屏有用得多。
type ErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

function detailOf(error: Error & { digest?: string }): string {
  const parts = [error?.name, error?.message].filter(Boolean);
  const head = parts.join(": ") || String(error);
  const stack = (error?.stack ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(0, 6)
    .join("\n");
  const digest = error?.digest ? `\n\ndigest: ${error.digest}` : "";
  return stack ? `${head}\n\n${stack}${digest}` : `${head}${digest}`;
}

export default function AppError({ error, reset }: ErrorProps) {
  React.useEffect(() => {
    // 同时打到 console，方便手机连着调试或用户反馈时附带。
    console.error("[pojun] 页面渲染出错:", error);

    // ChunkLoadError 自愈：轮换部署后 chunk 文件名（带构建 hash）会变，
    // 浏览器缓存的旧 HTML 仍引用旧 chunk -> 404 -> 页面抛 ChunkLoadError。
    // 这类错误刷新一次即可（拿到新 HTML/新 chunk）。用 sessionStorage 做
    // 防循环标记：每个会话最多自动刷新一次，仍失败就停在错误页让人反馈。
    const name = error?.name || "";
    const message = error?.message || "";
    const isChunkError =
      name === "ChunkLoadError" ||
      /chunk|Loading chunk|Failed to load chunk/i.test(message);
    if (!isChunkError) return;

    const KEY = "__pojun_chunk_recovered_at";
    try {
      const last = Number(sessionStorage.getItem(KEY) || 0);
      const now = Date.now();
      // 10 秒内已自动恢复过 -> 判定为循环，停在错误页；否则允许再次恢复。
      // 这样既防死循环，又不会让本次会话后续遇到的轮换问题失去自愈能力。
      if (last && now - last < 10_000) return;
      sessionStorage.setItem(KEY, String(now));
    } catch {
      // 隐私模式可能禁用 sessionStorage；仍能刷新，仅无法防循环。
    }
    // 硬刷新：绕过缓存拿新 HTML。短延迟让用户看到发生了什么。
    const timer = window.setTimeout(() => {
      try {
        window.location.reload();
      } catch {
        window.location.href = "/";
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [error]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <CircleAlertIcon className="size-8 text-destructive" />
      <div className="grid gap-1">
        <h1 className="font-semibold text-lg">这个页面出错了</h1>
        <p className="max-w-md text-muted-foreground text-sm">
          页面在渲染时抛了异常。下面的信息可以帮助定位原因（可直接截图反馈）。
        </p>
      </div>
      <pre className="max-h-64 w-full max-w-2xl overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 p-3 text-start font-mono text-xs">
        {detailOf(error)}
      </pre>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" onClick={() => reset()}>
          <RotateCcwIcon data-icon="inline-start" /> 重试
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            // 静态导出下没有服务端路由，硬跳比 router.push 更可靠。
            window.location.href = "/";
          }}
        >
          返回首页
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link href="/function/tasks">任务列表</Link>
        </Button>
      </div>
    </div>
  );
}
