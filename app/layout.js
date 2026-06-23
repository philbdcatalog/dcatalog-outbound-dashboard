export const metadata = {
  title: "DCatalog Outbound Dashboard",
  description: "Outbound sales analytics — webhooks + Supabase + Vercel",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          background: "#eef1f8",
          color: "#1f2a44",
        }}
      >
        {children}
      </body>
    </html>
  );
}
