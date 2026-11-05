export function BrandMark({ className = "size-7" }: { className?: string }) {
  return (
    <span
      className={`inline-flex ${className} items-center justify-center rounded-lg bg-accent text-accent-foreground`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 7h15a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7Z" />
        <path d="M3 7V6a2 2 0 0 1 2-2h11" />
        <circle cx="16.5" cy="13.5" r="1.25" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}
