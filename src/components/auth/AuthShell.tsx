import Image from "next/image";
import Link from "next/link";

export default function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-kca-black px-6 py-12">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: "radial-gradient(circle at 50% 0%, rgba(0, 200, 232, 0.12) 0%, transparent 45%)",
        }}
      />
      <section className="relative z-10 w-full max-w-md rounded-2xl border border-kca-border bg-kca-surface p-8 shadow-cyan-sm">
        <Link href="/" className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-xl border border-kca-cyan/20 bg-kca-black">
          <Image src="/kca-logo.png" alt="KCA" width={48} height={48} className="h-12 w-12 object-contain" priority />
        </Link>
        <div className="mb-8 text-center">
          <h1 className="font-display text-3xl font-bold text-kca-white">{title}</h1>
          <p className="mt-2 text-sm text-kca-gray-400">{subtitle}</p>
        </div>
        {children}
      </section>
    </main>
  );
}
