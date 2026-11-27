import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Donefac · 팀의 업무와 지식",
  description: "프로젝트의 업무, 일정, 문서, 코드를 한곳에서 연결합니다.",
  icons: {
    icon: "/donefac.svg",
    shortcut: "/donefac.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
