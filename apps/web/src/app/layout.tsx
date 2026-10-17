import type { Metadata } from 'next';
import { Inter, Inter_Tight, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { BRAND } from '@axiom/config';
import { serverDisplayTimeZone } from '@/lib/display-time';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

const interTight = Inter_Tight({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-head',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: {
    template: `%s · ${BRAND.name}`,
    default: `${BRAND.name} · ${BRAND.tagline}`,
  },
  description: BRAND.tagline,
  applicationName: BRAND.name,
  authors: [{ name: BRAND.company }],
  generator: 'Axiom Proof',
  keywords: ['DPDPA', 'compliance', 'AI agents', 'data protection', 'India'],
  referrer: 'strict-origin-when-cross-origin',
  robots: { index: false, follow: false }, // app subdomain is noindex
  metadataBase: new URL(`https://${BRAND.productDomain}`),
  openGraph: {
    type: 'website',
    siteName: BRAND.name,
    title: BRAND.name,
    description: BRAND.tagline,
  },
  icons: {
    icon: '/favicon.ico',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-display-tz={serverDisplayTimeZone()}
      className={`${inter.variable} ${interTight.variable} ${jetbrainsMono.variable} h-full`}
    >
      <body className="min-h-full bg-[#F4F6F8] font-body text-slate-700 antialiased">
        {children}
      </body>
    </html>
  );
}
