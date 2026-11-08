import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardBody } from "@/components/ui";
import { redirectIfSignedIn } from "@/lib/auth";
import { isRegistrationAllowed } from "@/lib/config";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: "Create account" };

export default async function RegisterPage() {
  await redirectIfSignedIn();
  if (!isRegistrationAllowed()) {
    return (
      <Card>
        <CardBody className="space-y-4 px-5! py-7! sm:px-7!">
          <h1 className="text-2xl font-extrabold tracking-tight text-foreground">Registration is disabled</h1>
          <p className="text-sm text-muted-foreground">
            This server isn’t accepting new accounts. Ask its administrator for access.
          </p>
          <p className="text-sm">
            <Link href="/login" className="font-medium text-accent hover:underline">
              Back to sign in
            </Link>
          </p>
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardBody className="space-y-6 px-5! py-7! sm:px-7!">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-foreground">Create your account</h1>
          <p className="mt-1 text-sm text-muted-foreground">Track spending across all your wallets and currencies.</p>
        </div>
        <RegisterForm />
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}
