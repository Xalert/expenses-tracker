import { LinkButton } from "@/components/ui";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-sm font-medium text-accent">404</p>
      <h1 className="text-2xl font-semibold text-foreground">Page not found</h1>
      <p className="text-sm text-muted-foreground">The page you’re looking for doesn’t exist or isn’t yours.</p>
      <LinkButton href="/" variant="secondary">
        Back to dashboard
      </LinkButton>
    </main>
  );
}
