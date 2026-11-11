import Link from 'next/link';

export default function NotFound() {
  return (
    <main style={{ padding: '64px 24px', maxWidth: 640, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span className="eyebrow">Not found</span>
      <h1>This page doesn&apos;t exist</h1>
      <p className="secondary">
        It may have moved. <Link href="/">Go to your home page</Link>
      </p>
    </main>
  );
}
