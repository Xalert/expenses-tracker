import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardBody } from "@/components/ui";
import { redirectIfSignedIn } from "@/lib/auth";
import { isRegistrationAllowed } from "@/lib/config";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await redirectIfSignedIn();
  const { deleted } = await searchParams;
  return (
    <Card>
      <CardBody className="space-y-6 px-5! py-7! sm:px-7!">
        {deleted === "1" && (
          <p role="status" className="rounded-xl border border-income/30 bg-income-soft px-3 py-2 text-sm text-income">
            Your account and all its data were deleted.
          </p>
        )}
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-foreground">Sign in</h1>
          <p className="mt-1 text-sm text-muted-foreground">Welcome back. Enter your details to continue.</p>
        </div>
        <LoginForm />
        <p className="text-center text-sm text-muted-foreground">
          Forgot your password? Ask the administrator of this server to reset it.
        </p>
        {isRegistrationAllowed() && (
          <p className="text-center text-sm text-muted-foreground">
            No account yet?{" "}
            <Link href="/register" className="font-medium text-accent hover:underline">
              Create one
            </Link>
          </p>
        )}
      </CardBody>
    </Card>
  );
}
