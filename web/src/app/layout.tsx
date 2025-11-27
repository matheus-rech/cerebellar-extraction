export const metadata = {
  title: 'CEREBELLAR-EXTRACT - Data Extraction Tool',
  description: 'Medical data extraction tool for systematic reviews',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
