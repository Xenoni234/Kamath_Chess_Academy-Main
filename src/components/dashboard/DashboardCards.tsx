import Link from "next/link";
import { Activity, BarChart3, CalendarDays, CircleDollarSign } from "lucide-react";
import type { StatCard } from "@/lib/dashboard";

const icons = [Activity, CalendarDays, BarChart3, CircleDollarSign];

export default function DashboardCards({ cards }: { cards: StatCard[] }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card, index) => {
        const Icon = icons[index % icons.length];
        const inner = (
          <>
            <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-lg border border-kca-cyan/20 bg-kca-cyan/10">
              <Icon className="h-5 w-5 text-kca-cyan" />
            </div>
            <div className="font-display text-3xl font-bold text-kca-white">{card.value}</div>
            <h2 className="mt-1 text-sm font-semibold text-kca-gray-100">{card.label}</h2>
            {card.hint && <p className="mt-1 text-xs text-kca-gray-400">{card.hint}</p>}
          </>
        );

        return card.href ? (
          <Link key={card.label} href={card.href} className="card min-h-36 block">
            {inner}
          </Link>
        ) : (
          <article key={card.label} className="card min-h-36">
            {inner}
          </article>
        );
      })}
    </div>
  );
}
