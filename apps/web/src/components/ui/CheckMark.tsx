/** A small drawn check, in the text colour. Decorative: pair it with words for assistive tech. */
export function CheckMark({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false" style={{ verticalAlign: '-0.1em' }}>
      <path d="M2.5 6.5 5 9l4.5-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
