import type { NextConfig } from "next";

// 정적 내보내기 전용: 런타임 SSR·ISR·Server Actions·Next 서버 API를 쓰지 않는다.
const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default config;
