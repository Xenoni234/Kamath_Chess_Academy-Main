#!/usr/bin/env python3
"""
Daily unique visitors, counted from Caddy's access log.

    # on the VPS
    docker compose exec -T caddy cat /var/log/caddy/access.log | python3 scripts/visitors.py
    # or, if the log volume is mounted on the host
    python3 scripts/visitors.py /var/lib/docker/volumes/kca_caddy-logs/_data/access.log

    --days N     how far back to report (default 14)
    --pages      also list the most-visited pages
    --raw        include asset and API requests in the page list

Why this and not Plausible or Google Analytics:

  * Caddy is already in the request path and already knows everything needed. A
    self-hosted analytics container is another service on a 2-vCPU box that has already
    gone down once under memory pressure.
  * No third-party script means no cookie banner, and no shipping a nine-year-old's
    browsing to an ad company. The academy's users are minors; that matters more here
    than it would elsewhere.

**IP addresses are personal data under the DPDPA, and this never writes one down.** Each
address is hashed with a salt that CHANGES EVERY DAY, so the count of distinct visitors
per day is right, while the same person on two days produces two unrelated hashes. That
makes cross-day tracking impossible by construction rather than by policy — which is the
only kind of promise worth making about someone else's child.

Counting is deliberately crude and stated as such: one browser is one visitor, a phone and
a laptop are two, and a shared school connection behind one NAT may look like one. It
answers "is anybody coming to the site" honestly. It is not an ad-network audience figure
and should not be quoted as one.
"""
import argparse
import hashlib
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone

# Requests that are not a person looking at a page.
ASSET = re.compile(r"\.(css|js|map|wasm|png|jpe?g|svg|gif|ico|webp|woff2?|ttf|txt|xml)$", re.I)
NON_PAGE_PREFIX = ("/api/", "/_next/", "/engine/", "/socket.io/")

# Crawlers identify themselves. This is not security — anything can lie — but it keeps
# Googlebot out of a number meant to represent people.
BOT = re.compile(
    r"bot|crawler|spider|slurp|bingpreview|facebookexternalhit|headless|lighthouse|"
    r"curl|wget|python-requests|monitor|uptime|pingdom",
    re.I,
)


def anon(ip: str, day: str, salt: str) -> str:
    """Hash an address with a per-day salt. Same person, different day, different hash."""
    return hashlib.sha256(f"{salt}:{day}:{ip}".encode()).hexdigest()[:16]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("logfile", nargs="?", help="Caddy JSON access log; omit to read stdin")
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--pages", action="store_true", help="also list the most-visited pages")
    ap.add_argument("--raw", action="store_true", help="do not filter assets and API calls")
    args = ap.parse_args()

    # A random salt per run. It never leaves this process, so even the output cannot be
    # turned back into addresses.
    salt = os.urandom(16).hex()

    stream = open(args.logfile, encoding="utf-8", errors="replace") if args.logfile else sys.stdin

    visitors: dict[str, set[str]] = defaultdict(set)
    requests_per_day: dict[str, int] = defaultdict(int)
    pages: dict[str, int] = defaultdict(int)
    bots = 0
    unparsed = 0

    with stream:
        for line in stream:
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                unparsed += 1
                continue

            # Caddy's JSON format. Guarded because the shape varies between versions and
            # a missing field should skip a line, not kill the report.
            ts = entry.get("ts")
            request = entry.get("request") or {}
            ip = request.get("remote_ip") or request.get("client_ip")
            uri = request.get("uri") or ""
            if ts is None or not ip:
                unparsed += 1
                continue

            headers = request.get("headers") or {}
            agent = " ".join(headers.get("User-Agent") or [])
            if BOT.search(agent):
                bots += 1
                continue

            day = datetime.fromtimestamp(float(ts), tz=timezone.utc).strftime("%Y-%m-%d")

            path = uri.split("?", 1)[0]
            is_page = not (path.startswith(NON_PAGE_PREFIX) or ASSET.search(path))

            # A visitor is counted from PAGE views only. Counting asset requests would
            # make one person loading one page look like a crowd.
            if is_page or args.raw:
                visitors[day].add(anon(ip, day, salt))
                requests_per_day[day] += 1
                if args.pages:
                    pages[path] += 1

    if not visitors:
        print("No page views found in that log.")
        print("If the file exists but is empty, Caddy may not have the `log` directive yet")
        print("— see deploy/Caddyfile.")
        return 1

    days = sorted(visitors)[-args.days :]
    width = max(len(d) for d in days)
    peak = max(len(visitors[d]) for d in days) or 1

    print(f"{'DATE':<{width}}  {'VISITORS':>8}  {'VIEWS':>7}")
    print("-" * (width + 20))
    for day in days:
        count = len(visitors[day])
        bar = "█" * max(1, round(count / peak * 24))
        print(f"{day:<{width}}  {count:>8}  {requests_per_day[day]:>7}  {bar}")

    total_unique_days = sum(len(visitors[d]) for d in days)
    print("-" * (width + 20))
    print(f"{'TOTAL':<{width}}  {total_unique_days:>8}  {sum(requests_per_day[d] for d in days):>7}")
    print()
    print(f"Bot requests ignored: {bots}")
    if unparsed:
        print(f"Lines skipped (not a usable log entry): {unparsed}")
    print()
    print("A 'visitor' is one address on one day. Two devices count twice; a shared")
    print("connection may count once. Addresses are hashed with a salt that changes every")
    print("day and is discarded when this exits — no address is stored, and the same")
    print("person on two days cannot be linked.")

    if args.pages and pages:
        print("\nMost visited pages")
        for path, hits in sorted(pages.items(), key=lambda kv: -kv[1])[:15]:
            print(f"  {hits:>7}  {path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
