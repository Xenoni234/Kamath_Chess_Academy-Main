import type { ReactNode } from "react";

/** Shared shell for the legal pages so Terms and Privacy stay visually identical. */
export default function LegalDoc({
  title,
  updated,
  intro,
  children,
}: {
  title: string;
  updated: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <section className="min-h-[60vh] bg-kca-black px-6 py-32 md:px-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="section-heading">{title}</h1>
        <p className="mt-2 text-sm text-kca-gray-500">Last updated: {updated}</p>
        <p className="section-subheading mt-4">{intro}</p>
        <div className="mt-10 space-y-8 text-sm leading-relaxed text-kca-gray-100">{children}</div>
      </div>
    </section>
  );
}

export function Clause({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="mb-2 font-display text-base font-semibold text-kca-white">{heading}</h2>
      <div className="space-y-2 text-kca-gray-100">{children}</div>
    </div>
  );
}
