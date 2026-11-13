import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { AuthAside } from "@/components/marketing/auth-aside";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-bg lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col px-6 py-6 sm:px-10">
        <Link href="/" aria-label="Necessa home" className="w-fit">
          <Logo />
        </Link>
        <main id="main" className="mx-auto flex w-full max-w-[380px] flex-1 flex-col justify-center py-12">
          {children}
        </main>
        <p className="text-xs text-subtle">Synthetic data only in demo mode · Necessa never makes coverage decisions.</p>
      </div>
      <AuthAside />
    </div>
  );
}
