"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { auth } from "@/lib/auth";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace(auth.getToken() ? "/function/tasks" : "/login");
  }, [router]);
  return null;
}
