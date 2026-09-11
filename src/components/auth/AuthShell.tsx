import Image from "next/image";
import Link from "next/link";

/**
 * The full-page frame for every signed-out screen.
 *
 * It owns `min-h-screen` and vertical centring, so **exactly one of these may
 * render per page.** Nesting a second — which happened when LoginForm rendered
 * its own shell and the /login picker rendered above it — stacks two full
 * viewports and leaves a screen-high gap between them.
 *
 * `wide` is for the portal picker, whose two-column grid does not fit the
 * max-w-md card the single-form screens use.
 */
export default function AuthShell({
  title,
  subtitle,
  wide = false,
  children,
}: {
  title: string;
  subtitle: string;
  wide?: boolean;
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
      <section
        className={`relative z-10 w-full ${wide ? "max-w-2xl" : "max-w-md"} rounded-2xl border border-kca-border bg-kca-surface p-8 shadow-cyan-sm`}
      >
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
