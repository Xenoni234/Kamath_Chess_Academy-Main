export default function DashboardHeader({ title, username }: { title: string; username: string }) {
  return (
    <header className="mb-8">
      <p className="font-display text-xs font-bold uppercase tracking-widest text-kca-cyan">Dashboard</p>
      <h1 className="mt-3 font-display text-3xl font-bold text-kca-white md:text-4xl">{title}</h1>
      <p className="mt-3 text-kca-gray-400">Welcome back, {username}.</p>
    </header>
  );
}
