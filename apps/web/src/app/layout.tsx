import type { Metadata, Viewport } from 'next';
import { Inter, Inter_Tight, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import '@/styles/globals.css';

const inter = Inter({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-inter', display: 'swap' });
const interTight = Inter_Tight({ subsets: ['latin'], weight: ['600', '700'], variable: '--font-inter-tight', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-jetbrains-mono', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'RoundDigital Track', template: '%s · RoundDigital Track' },
  description: 'Transparent work sessions and computer activity. You see everything your manager sees.',
  icons: { icon: '/brand/rd-mark.png' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#0B0C0F',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${interTight.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
