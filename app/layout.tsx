import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Thor Marble Race',
  description:
    'A marble race winner picker. Track, marbles, particles and the winner reveal are all drawn with @thorvg/webcanvas.',
};

export const viewport: Viewport = {
  themeColor: '#08080a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
