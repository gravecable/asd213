import type { Metadata } from "next";
import { Press_Start_2P } from "next/font/google";
import { PvpLoader } from "@/components/pvp/pvp-loader";

const pixel = Press_Start_2P({
  variable: "--font-pixel",
  weight: "400",
  subsets: ["latin", "cyrillic"],
});

export const metadata: Metadata = {
  title: "Блок-Арена — PvP онлайн",
  description:
    "Кубический PvP до последнего выжившего: до 12 игроков, круглая арена, новый баф каждые 2 минуты.",
};

export default function HomePage() {
  return (
    <div className={pixel.variable}>
      <PvpLoader />
    </div>
  );
}
