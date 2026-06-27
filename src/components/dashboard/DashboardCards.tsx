import { Activity, BarChart3, CalendarDays, CircleDollarSign } from "lucide-react";

const icons = [Activity, CalendarDays, BarChart3, CircleDollarSign];

export default function DashboardCards({ cards }: { cards: string[] }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card, index) => {
        const Icon = icons[index % icons.length];

        return (
          <article key={card} className="card min-h-36">
            <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-lg border border-kca-cyan/20 bg-kca-cyan/10">
              <Icon className="h-5 w-5 text-kca-cyan" />
            </div>
            <h2 className="font-display text-lg font-bold text-kca-white">{card}</h2>
            <p className="mt-2 text-sm leading-6 text-kca-gray-400">Placeholder metrics will appear here as Phase 0 data is connected.</p>
          </article>
        );
      })}
    </div>
  );
}
