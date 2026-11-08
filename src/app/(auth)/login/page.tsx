import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardBody } from "@/components/ui";
import { redirectIfSignedIn } from "@/lib/auth";
import { isRegistrationAllowed } from "@/lib/config";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  await redirectIfSignedIn();
  return (
    <Card>
      <CardBody className="space-y-6 px-5! py-7! sm:px-7!">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-foreground">Sign in</h1>
          <p className="mt-1 text-sm text-muted-foreground">Welcome back. Enter your details to continue.</p>
        </div>
        <LoginForm />
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
