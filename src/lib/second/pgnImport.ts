/**
 * All PGN parsing for the Digital Second, in one place.
 *
 * Three sources now hand us PGN — Chess.com archives, OTB broadcast exports and
 * games pasted by hand — so the tag readers, clock extractor and SAN stripper
 * live here rather than being private to `ingest.ts`.
 *
 * The load-bearing piece is `splitPgnGames`. `buildLineFromPgn`
 * (engine/analysis.ts) returns null for ANY string holding more than one game,
 * because chess.js throws on the second `[Event`; and `sanFromPgn` silently
 * concatenates two games into one illegal move list, which the line builder
 * then truncates without an error. Anything accepting a multi-game PGN has to
 * split it first.
 */
import crypto from "node:crypto";
import { Chess } from "chess.js";
import type { RawGame, Termination, TimeControl } from "@/lib/second/types";

/** Read a single PGN header tag. */
export function pgnTag(pgn: string, tag: string): string | null {
  const match = new RegExp(`\\[${tag}\\s+"([^"]*)"\\]`).exec(pgn);
  return match?.[1] || null;
}

/** Parse a PGN date+time tag pair ("2026.08.15" + "12:34:56") to epoch ms, UTC. */
export function pgnTimestampMs(pgn: string, dateTag: string, timeTag: string): number | null {
  const date = pgnTag(pgn, dateTag);
  const time = pgnTag(pgn, timeTag);
  if (!date) return null;
  // PGN uses "????" for unknown components; those cannot be salvaged.
  if (date.includes("?")) return null;
  const iso = `${date.replace(/\./g, "-")}T${time ?? "00:00:00"}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** One ply of a game: the move, and the comment block attached to it. */
export type PgnPly = { san: string; comment: string | null };

const RESULT_TOKEN = /^(1-0|0-1|1\/2-1\/2|\*)$/;

/**
 * Walk one game's movetext into plies, each carrying its own comment.
 *
 * Everything per-ply — the SAN list, the clocks, the evals — is derived from
 * THIS ONE walk, so those arrays cannot drift out of alignment with each other.
 * That matters more than it looks: sweeping the text for `[%clk]` with a global
 * regex reads correctly and is wrong, because a ply carrying an eval but no
 * clock shifts every clock after it by one. Measured on a real broadcast game,
 * ply 100 of 186 had `{ [%eval 0.34] }` and no clock — which silently turned
 * every later think time into the previous move's.
 *
 * Variations are skipped entirely: a move inside `(...)` was never played, and
 * counting it corrupts the move list and every index after it. Braces are read
 * with awareness of each other, so a `(` inside a comment stays text.
 */
export function walkMovetext(pgn: string): PgnPly[] {
  // Header tags only — `[%clk ...]` lives inside comments and must survive.
  const body = pgn.replace(/^\s*\[[^\]]*\]\s*$/gm, " ");
  const plies: PgnPly[] = [];
  let depth = 0;
  let token = "";
  let i = 0;

  const flush = () => {
    if (!token) return;
    const raw = token;
    token = "";
    if (depth > 0) return;
    if (RESULT_TOKEN.test(raw) || raw.startsWith("$")) return;
    // The move number may be glued to the move: "12.Nf3", "12...Nc6".
    const t = raw.replace(/^\d+\.+/, "");
    // Old OTB exports write "e.p." after an en-passant capture. Left in, it is
    // an illegal token and the line builder silently truncates the game there.
    if (!t || t === "..." || t === "e.p." || /^\d+$/.test(t)) return;
    const san = t.replace(/[?!]+/g, "");
    if (san) plies.push({ san, comment: null });
  };

  while (i < body.length) {
    const ch = body[i];
    if (ch === "{") {
      flush();
      const close = body.indexOf("}", i + 1);
      const stop = close === -1 ? body.length : close;
      const last = plies[plies.length - 1];
      if (depth === 0 && last) {
        const text = body.slice(i + 1, stop);
        last.comment = last.comment ? `${last.comment} ${text}` : text;
      }
      i = stop + 1;
      continue;
    }
    if (ch === ";") {
      // Rest-of-line comment.
      flush();
      const nl = body.indexOf("\n", i);
      i = nl === -1 ? body.length : nl + 1;
      continue;
    }
    if (ch === "(") {
      flush();
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      flush();
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      i += 1;
      continue;
    }
    token += ch;
    i += 1;
  }
  flush();
  return plies;
}

/** Remaining clock in centiseconds. Hours are optional ("4:31" = 4m31s). */
function clkFromComment(comment: string | null): number | null {
  if (!comment) return null;
  const m = /\[%clk\s+(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\]/.exec(comment);
  if (!m) return null;
  const hours = m[1] ? Number(m[1]) : 0;
  return Math.round((hours * 3600 + Number(m[2]) * 60 + Number(m[3])) * 100);
}

function evalFromComment(comment: string | null): number | null {
  if (!comment) return null;
  const m = /\[%eval\s+(#?-?\d+(?:\.\d+)?)\]/.exec(comment);
  if (!m) return null;
  const raw = m[1];
  // "#-3" is mate in 3 for Black — collapse to a large finite pawn value.
  if (raw.startsWith("#")) return raw.includes("-") ? -100 : 100;
  return Number(raw);
}

/**
 * Remaining-clock centiseconds per ply, index-aligned to `sanFromPgn`.
 *
 * `null` at a ply means that ply had no clock, NOT that no clock exists —
 * keeping the hole is what preserves alignment for every later ply. Returns
 * undefined only when the PGN carries no clock anywhere, so callers can keep
 * treating `clocks` as "is there clock data at all".
 */
export function clocksFromPgn(pgn: string): (number | null)[] | undefined {
  const out = walkMovetext(pgn).map((p) => clkFromComment(p.comment));
  return out.some((v) => v !== null) ? out : undefined;
}

/** Lichess's own `[%eval]` in pawns, per ply, index-aligned to `sanFromPgn`. */
export function evalsFromPgn(pgn: string): (number | null)[] | undefined {
  const out = walkMovetext(pgn).map((p) => evalFromComment(p.comment));
  return out.some((v) => v !== null) ? out : undefined;
}

/**
 * Make a PGN readable by chess.js.
 *
 * Lichess writes SEPARATE comment blocks per move — one for the eval, one for
 * any annotation text, one for the clock:
 *
 *   51... Rf7?! { [%eval 4.81] } { Inaccuracy. Rf1 was best. } { [%clk 0:02:05] }
 *
 * chess.js accepts at most one comment per move and throws "Expected end of
 * input, game termination marker, move number" on the second. Measured: this
 * rejected 89 of 90 games in a real broadcast export. Merging adjacent blocks
 * into one keeps every %clk and %eval intact — both are read from the raw text
 * anyway — and costs nothing.
 */
export function normalisePgn(pgn: string): string {
  return pgn.replace(/\r\n?/g, "\n").replace(/\}\s*\{/g, " ");
}

/** Strip a PGN to a bare SAN move list ("e4 e5 Nf3 ..."). ONE game only. */
export function sanFromPgn(pgn: string): string {
  return walkMovetext(pgn)
    .map((p) => p.san)
    .join(" ");
}

/**
 * Split a multi-game PGN into single-game strings.
 *
 * Splits on `[Event` at the start of a line, which is the PGN standard's own
 * game boundary, and tolerates CRLF and leading whitespace. A string with no
 * `[Event` tag at all is treated as one bare-movetext game.
 */
export function splitPgnGames(text: string): string[] {
  const normalised = text.replace(/\r\n?/g, "\n").trim();
  if (!normalised) return [];

  const starts: number[] = [];
  const re = /^[ \t]*\[Event\s/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalised)) !== null) starts.push(m.index);

  if (starts.length === 0) return [normalised];

  const games: string[] = [];
  // Bare movetext before the first [Event] is not a game; discard it.
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : normalised.length;
    const chunk = normalised.slice(starts[i], end).trim();
    if (chunk) games.push(chunk);
  }
  return games;
}

/**
 * Deterministic id for a game that has no natural one.
 *
 * Must be stable across pastes: pasting the same batch twice has to dedupe to
 * nothing, or every weighted figure in the dossier silently doubles. Derived
 * from the players, the date and the opening moves rather than the whole text,
 * so trivial reformatting does not mint a new id.
 */
export function syntheticGameId(pgn: string, san: string): string {
  const key = [
    pgnTag(pgn, "White") ?? "",
    pgnTag(pgn, "Black") ?? "",
    pgnTag(pgn, "Date") ?? pgnTag(pgn, "UTCDate") ?? "",
    san.split(" ").slice(0, 20).join(" "),
  ].join("|");
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
}

const PGN_TERMINATION: Record<string, Termination> = {
  normal: "unknown",
  "time forfeit": "flagged",
  abandoned: "abandoned",
  "rules infraction": "rules-infraction",
  unterminated: "unknown",
};

/** A game that could not be turned into a usable record, and why. */
export type PgnRejection = { index: number; label: string; reason: string };

export type PgnImportResult = {
  games: RawGame[];
  rejected: PgnRejection[];
};

/** Best-effort label for error messages, before we know if the game parses. */
function gameLabel(pgn: string, index: number): string {
  const white = pgnTag(pgn, "White");
  const black = pgnTag(pgn, "Black");
  if (white && black) return `${white} vs ${black}`;
  return `game ${index + 1}`;
}

/**
 * Does this PGN name the player we are profiling, and on which side?
 *
 * Handles both "Kapadi Yash" and "Kapadi, Yash" by comparing the set of
 * name words, because OTB and online exports disagree on ordering and commas.
 */
function sideOf(pgn: string, playerName: string): "w" | "b" | null {
  const words = (value: string) =>
    value
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean)
      .sort()
      .join(" ");
  const wanted = words(playerName);
  if (!wanted) return null;
  const white = pgnTag(pgn, "White");
  const black = pgnTag(pgn, "Black");
  if (white && words(white) === wanted) return "w";
  if (black && words(black) === wanted) return "b";
  return null;
}

/**
 * Turn one PGN game into a `RawGame` for the profiled player.
 *
 * `forcedColor` covers pasted games where the name does not match either side —
 * the UI asks rather than guessing, because getting the colour wrong profiles
 * the opponent's opponent.
 */
export function parsePgnGame(
  pgn: string,
  options: { playerName?: string; playerFideId?: string; forcedColor?: "w" | "b" },
): { game: RawGame } | { error: string } {
  // chess.js validates the moves; sanFromPgn alone would happily accept
  // nonsense and let the line builder truncate it silently.
  let history: { san: string }[];
  try {
    const board = new Chess();
    board.loadPgn(normalisePgn(pgn));
    history = board.history({ verbose: true });
  } catch (error) {
    return { error: `moves could not be read (${(error as Error).message.slice(0, 60)})` };
  }
  if (history.length === 0) return { error: "no moves" };

  const san = history.map((move) => move.san).join(" ");

  // Identity: FIDE id is exact, name matching is a fallback, and an explicit
  // choice beats both.
  let color: "w" | "b" | null = options.forcedColor ?? null;
  if (!color && options.playerFideId) {
    if (pgnTag(pgn, "WhiteFideId") === options.playerFideId) color = "w";
    else if (pgnTag(pgn, "BlackFideId") === options.playerFideId) color = "b";
  }
  if (!color && options.playerName) color = sideOf(pgn, options.playerName);
  if (!color) {
    return {
      error: "could not tell which side the player was — check the name spelling in the PGN",
    };
  }

  const endedAtMs =
    pgnTimestampMs(pgn, "UTCDate", "UTCTime") ??
    pgnTimestampMs(pgn, "EndDate", "EndTime") ??
    pgnTimestampMs(pgn, "Date", "Time");
  if (endedAtMs === null) {
    // Never default to "now": that would hand an undated game FULL recency
    // weight, the maximum confidence for the minimum information.
    return { error: "no usable date — recency weighting needs one" };
  }

  const result = pgnTag(pgn, "Result");
  const won = result === (color === "w" ? "1-0" : "0-1");
  const drawn = result === "1/2-1/2";

  const terminationRaw = pgnTag(pgn, "Termination");
  const ratingTag = color === "w" ? "WhiteElo" : "BlackElo";
  const otherRatingTag = color === "w" ? "BlackElo" : "WhiteElo";
  const number = (value: string | null) => {
    const n = Number(value);
    return value && Number.isFinite(n) ? n : null;
  };

  const tcRaw = pgnTag(pgn, "TimeControl");
  const tc: TimeControl = parsePgnTimeControl(tcRaw);

  const clocks = clocksFromPgn(pgn); // (number|null)[] | undefined — holes preserve ply alignment

  return {
    game: {
      color,
      san,
      openingName: pgnTag(pgn, "Opening") ?? "Unknown Opening",
      eco: pgnTag(pgn, "ECO"),
      won,
      drawn,
      gameId: syntheticGameId(pgn, san),
      // Only ever from an explicit tag. A loss does not mean a resignation, and
      // inferring one from Result would invent evidence.
      termination: terminationRaw
        ? (PGN_TERMINATION[terminationRaw.toLowerCase()] ?? "unknown")
        : "unknown",
      terminationRaw,
      tc,
      rated: null,
      playerRating: number(pgnTag(pgn, ratingTag)),
      opponentRating: number(pgnTag(pgn, otherRatingTag)),
      opponentHandle: pgnTag(pgn, color === "w" ? "Black" : "White"),
      startedAtMs: pgnTimestampMs(pgn, "UTCDate", "UTCTime"),
      endedAtMs,
      clocks,
    },
  };
}

/** PGN `[TimeControl]` is "600+5", "600", "-" (none) or "40/7200:1800". */
export function parsePgnTimeControl(raw: string | null): TimeControl {
  const base: TimeControl = {
    initialSec: null,
    incrementSec: null,
    perMoveSec: null,
    speed: "unknown",
    raw,
  };
  if (!raw || raw === "-" || raw === "?") return base;

  const withIncrement = /^(\d+)\+(\d+)$/.exec(raw);
  if (withIncrement) {
    return { ...base, initialSec: Number(withIncrement[1]), incrementSec: Number(withIncrement[2]) };
  }
  if (/^\d+$/.test(raw)) return { ...base, initialSec: Number(raw), incrementSec: 0 };

  // Moves-per-period formats ("40/7200:1800"): the first period's base is the
  // only part that maps onto our model, and the increment is genuinely unknown.
  const period = /^(\d+)\/(\d+)/.exec(raw);
  if (period) return { ...base, initialSec: Number(period[2]) };

  return base;
}

/**
 * Import a block of pasted PGN.
 *
 * Reports per-game failures rather than failing the batch: "12 of 15 loaded,
 * 3 rejected" is actionable, a blanket "invalid PGN" is not.
 */
export function importPastedPgn(
  text: string,
  options: { playerName?: string; playerFideId?: string; forcedColor?: "w" | "b"; max?: number },
): PgnImportResult {
  const chunks = splitPgnGames(text);
  const limit = options.max ?? chunks.length;
  const games: RawGame[] = [];
  const rejected: PgnRejection[] = [];
  const seen = new Set<string>();

  chunks.forEach((chunk, index) => {
    if (index >= limit) {
      rejected.push({
        index,
        label: gameLabel(chunk, index),
        reason: `over the ${limit}-game limit`,
      });
      return;
    }
    const parsed = parsePgnGame(chunk, options);
    if ("error" in parsed) {
      rejected.push({ index, label: gameLabel(chunk, index), reason: parsed.error });
      return;
    }
    // Same game twice in one paste would double its weight.
    if (seen.has(parsed.game.gameId)) {
      rejected.push({ index, label: gameLabel(chunk, index), reason: "duplicate of an earlier game" });
      return;
    }
    seen.add(parsed.game.gameId);
    games.push(parsed.game);
  });

  return { games, rejected };
}

/**
 * A compact, display-ready summary of one accepted pasted game — no move tree,
 * just what the paste-preview UI shows in a row.
 */
export type PgnPreviewGame = {
  index: number;
  /** Which side the profiled opponent played in this game. */
  opponentColor: "w" | "b";
  /** The opponent's result. */
  result: "won" | "drawn" | "lost";
  /** ISO date (YYYY-MM-DD) from the game's end/start, or null when unknown. */
  date: string | null;
  /** Full moves (plies / 2, rounded up). */
  moveCount: number;
  opening: string;
  eco: string | null;
  /** The other player's name, when the PGN carried it. */
  opponentName: string | null;
};

export type PgnPreviewResult = {
  accepted: PgnPreviewGame[];
  rejected: PgnRejection[];
  total: number;
};

/**
 * Preview a paste WITHOUT running a profile: parse it with the exact same
 * `importPastedPgn` the job uses (so the preview can never disagree with what
 * actually gets ingested) and return a compact per-game summary plus the
 * rejection list. Pure and side-effect-free — safe to call on every keystroke.
 */
export function previewPastedPgn(
  text: string,
  options: { playerName?: string; playerFideId?: string; forcedColor?: "w" | "b"; max?: number },
): PgnPreviewResult {
  const { games, rejected } = importPastedPgn(text, options);
  const accepted: PgnPreviewGame[] = games.map((g, i) => {
    const ms = g.endedAtMs ?? g.startedAtMs;
    const plies = g.san.split(/\s+/).filter(Boolean).length;
    const result: "won" | "drawn" | "lost" = g.won ? "won" : g.drawn ? "drawn" : "lost";
    return {
      index: i,
      opponentColor: g.color,
      result,
      date: ms ? new Date(ms).toISOString().slice(0, 10) : null,
      moveCount: Math.ceil(plies / 2),
      opening: g.openingName,
      eco: g.eco,
      opponentName: g.opponentHandle,
    };
  });
  return { accepted, rejected, total: accepted.length + rejected.length };
}
