import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RunoffLab",
  description: "Model how rain gardens and permeable pavement change stormwater runoff, using EPA SWMM.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
