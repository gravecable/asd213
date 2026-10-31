"use client";

import dynamic from "next/dynamic";

// WebGL, WebSocket and localStorage are browser-only, so the game never renders on the server.
const PvpGame = dynamic(() => import("./pvp-game"), {
  ssr: false,
  loading: () => <div className="fixed inset-0 flex items-center justify-center bg-[#8fc8ff] text-2xl text-white">Загрузка арены…</div>,
});

export function PvpLoader() {
  return <PvpGame />;
}
