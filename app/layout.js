import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export const metadata = {
  title: "DCatalog GTM Dashboard",
  description: "Outbound sales analytics — webhooks + Supabase + Vercel",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={inter.className}>
      <body
        style={{
          margin: 0,
          background: "#f7f8fa",
          color: "#1a2332",
          WebkitFontSmoothing: "antialiased",
          MozOsxFontSmoothing: "grayscale",
        }}
      >
        {children}
      </body>
    </html>
  );
}
