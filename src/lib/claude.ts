import Anthropic from "@anthropic-ai/sdk";
import { pristineFetch } from "@/lib/pristineFetch";
import { MIN_OPENING_GAMES } from "@/lib/reports/gameStats";
import type { MoveFacts } from "@/lib/analysis/moveFacts";

/**
 * AI narration for move explanations and report narratives.
 *
 * The provider is pluggable behind a stable interface so the calling routes
 * (analysis explain, report generation) never change:
 *   - "openai-compatible" — any host speaking OpenAI's /chat/completions, which
 *                   is nearly all of them (Groq, Cerebras, DeepSeek, OpenRouter,
 *                   Together, OpenAI itself). Defaults to Groq. Switching
 *                   provider is an env change, not a code change.
 *   - "anthropic" — Claude API (needs ANTHROPIC_API_KEY).
 *   - "ollama"    — a self-hosted Ollama server (OLLAMA_URL). Opt-in only; a
 *                   model small enough to run locally is markedly weaker, and
 *                   it competes with Stockfish for the same cores.
 *   - "template"  — deterministic, offline prose built from the engine numbers.
 *                   Free, and chess-safe (it never invents tactics).
 *
 * Selection: AI_PROVIDER wins if set; otherwise whichever key is present,
 * preferring the OpenAI-compatible host. Ollama is never auto-selected.
 */
type AiProvider = "anthropic" | "openai-compatible" | "ollama" | "template";

function activeProvider(): AiProvider {
  const explicit = process.env.AI_PROVIDER?.toLowerCase();
  if (
    explicit === "anthropic" ||
    explicit === "openai-compatible" ||
    explicit === "ollama" ||
    explicit === "template"
  ) {
    return explicit;
  }
  if (llmApiKey()) return "openai-compatible";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "template";
}

/**
 * Move explanations are built from VERIFIED facts, never from a raw position.
 *
 * This used to be a FEN plus a few numbers, and the model was asked to work out
 * the tactics itself — which it cannot do reliably from a FEN string, so it
 * invented them. `MoveFacts` (lib/analysis/moveFacts.ts) is computed by chess.js
 * and the validated motif detector before we ever call a model.
 */
export type ChessMoveExplanationParams = MoveFacts;

export type GameReportStats = {
  username: string;
  totalGames: number;
  /** How many of the player's own moves the engine actually scored. */
  movesAnalyzed: number;
  overallAccuracy: number;
  /** Percentages of the player's analysed moves, not of games. */
  blunderRate: number;
  mistakeRate: number;
  inaccuracyRate: number;
  openingAccuracy: number;
  middlegameAccuracy: number;
  endgameAccuracy: number;
  /**
   * Grouped by opening FAMILY, not by exact move order — see `openingFamily`.
   * `winRate` is a SCORE percentage (win 1, draw ½), and it is **null below
   * MIN_OPENING_GAMES**: a rate from one game is not a finding, and printing it
   * as one is how "you have a 100% win rate in the Closed Sicilian" reached a
   * child who had played it once.
   */
  topOpenings: Array<{ name: string; winRate: number | null; count: number }>;
  weakestOpenings: Array<{ name: string; accuracy: number; count: number }>;
  tacticalPatternsMissed: string[];
  /**
   * Deep self-profile, already rendered to prompt text by
   * `describeSelfProfile` (src/lib/reports/selfProfile.ts): the same weakness,
   * tactical, behavioural and evolution stages the opponent dossier runs, pointed
   * at the student's own games and split by colour.
   *
   * Optional because every stage degrades independently — a failed or too-thin
   * scan costs these sections, never the report. Absent means "we could not build
   * it", NEVER "there is nothing to say", and the prompt must not imply otherwise.
   */
  selfProfile?: string;
};

/**
 * Whether the active provider can serve a request. Routes that stream should
 * check this first — once a stream is open there is no way to send a status
 * code, so an unconfigured provider would surface as a dropped connection.
 * The template provider always works; Ollama is assumed reachable when chosen.
 */
export function isClaudeConfigured(): boolean {
  const provider = activeProvider();
  if (provider === "anthropic") return Boolean(process.env.ANTHROPIC_API_KEY);
  if (provider === "openai-compatible") return Boolean(llmApiKey());
  return true;
}

// ---------------------------------------------------------------------------
// Prompts (shared by the Anthropic and Ollama providers)
// ---------------------------------------------------------------------------

/**
 * The anti-invention clause is the whole point. Every other prompt here already
 * carries one; this one did not, and the result was a coach that confidently
 * described forks and pins that were not on the board.
 */
const MOVE_EXPLANATION_SYSTEM =
  "You are a chess coach explaining a move to a student. The position and the move have already been analysed by a chess engine and by a position checker — every fact you need is given to you. Never invent a move, never name a move that is not in the supplied list, never contradict the supplied evaluations, and never claim a tactic that is not listed, and never state that a piece stands on a square unless the supplied piece list puts it there. If the facts do not explain why a move is good, say plainly what the move does and what the evaluation shows instead of speculating.";
/**
 * The audience is a child and their parent, not a chess engine operator.
 *
 * The figures stay — a parent paying fees wants to see them, and a coach needs them — but
 * the sentences around them have to be readable by the student the report is about. The
 * academy's students start at five and six.
 */
const REPORT_SYSTEM =
  "You are a chess coach writing a performance report for a young student and their parent. " +
  "Be DETAILED — go through everything the numbers show and explain what each one means for " +
  "their play. But write it in plain, warm, everyday language a child can read: short sentences, " +
  "no jargon, and explain any chess term you use the first time. Detailed does not mean technical. " +
  "Keep every figure you are given, and say what it means in words as well as numbers. " +
  "Be encouraging and specific about what to practise next.";
const REPERTOIRE_SYSTEM =
  "You are a chess second preparing a player for a specific opponent. You annotate lines that have already been chosen by engine analysis — never invent moves, never contradict the supplied evaluations.";
const OPENING_SYSTEM =
  "You are a chess coach teaching an opening to a student. You explain the plans and ideas behind lines that have already been chosen by engine analysis — never invent moves, never contradict the supplied evaluations.";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

/**
 * `words` is a budget, not a style choice. A 2B local model spends real seconds
 * per token, so its explanations are kept short; a hosted model returns 150
 * words in about the time Ollama takes for 40, and the extra room buys a
 * genuinely better explanation rather than a padded one.
 */
/** Readable phrase for a detected motif. */
const MOTIF_PHRASE: Record<string, string> = {
  fork: "a fork",
  skewer: "a skewer",
  discoveredAttack: "a discovered attack",
  hangingPiece: "the win of an undefended piece",
  backRankMate: "a back-rank mate",
  pin: "a pin",
};

/** One move rendered as plain facts — what it literally does on the board. */
function describeForPrompt(m: MoveFacts["played"]): string {
  const bits = [`${m.piece} ${m.from}-${m.to}`];
  if (m.isCapture) bits.push(`captures a ${m.captured ?? "piece"}`);
  if (m.isPromotion) bits.push("promotes");
  if (m.isCastle) bits.push("castles");
  if (m.isMate) bits.push("is checkmate");
  else if (m.isCheck) bits.push("gives check");
  const tactics = m.motifs.length
    ? `creates ${m.motifs.map((x) => MOTIF_PHRASE[x] ?? x).join(" and ")}`
    : "creates no tactic";
  return `${bits.join(", ")}; ${tactics}`;
}

/**
 * Build the prompt from verified facts.
 *
 * The FEN appears only as a trailing reference — the model is told not to
 * analyse it, because every conclusion it needs is already stated above. This is
 * the difference between a coach that reports analysis and one that guesses.
 */
function moveExplanationPrompt(f: MoveFacts, words: number) {
  const L: string[] = [];

  L.push(`POSITION`);
  L.push(`- You are playing ${f.student}. Move ${f.moveNumber}, ${f.phase}.`);
  L.push(`- White pieces: ${f.pieces.white}`);
  L.push(`- Black pieces: ${f.pieces.black}`);
  L.push(`- Material: ${f.material}.`);
  if (f.inCheckBefore) L.push(`- You were in check.`);
  if (f.forced) L.push(`- This was the ONLY legal move — it was forced.`);

  L.push(``, `THE MOVE YOU PLAYED: ${f.played.san}`);
  L.push(`- ${describeForPrompt(f.played)}.`);
  L.push(
    `- The square ${f.target.square} is hit by your ${f.target.yours || "(nothing)"} and defended by their ${f.target.theirs || "(nothing)"}. This is the COMPLETE list — do not claim any other piece attacks or defends it.`,
  );
  if (f.evalBefore) L.push(`- Evaluation before it (your side): ${f.evalBefore}.`);
  if (f.evalAfter) L.push(`- Evaluation after it (your side): ${f.evalAfter}.`);
  if (f.classificationLabel) {
    L.push(`- Engine verdict: ${f.classificationLabel}${f.symbol ? ` (${f.symbol})` : ""}${f.cpLoss ? `, giving up ${f.cpLoss} centipawns` : ""}.`);
  }

  if (f.playedWasBest) {
    L.push(``, `This WAS the engine's first choice — tell them why it is right.`);
  } else if (f.best) {
    L.push(``, `THE ENGINE PREFERRED: ${f.best.san}`);
    L.push(`- ${describeForPrompt(f.best)}.`);
    if (f.best.line) L.push(`- Its line: ${f.best.line}`);
  }

  if (f.missedMotifs.length) {
    L.push(
      ``,
      `WHAT YOU MISSED: ${f.missedMotifs
        .map((x) => `${MOTIF_PHRASE[x.motif] ?? x.motif} (detector accuracy ${Math.round(x.precision * 100)}%)`)
        .join(", ")}.`,
    );
  }
  if (f.refutation) L.push(``, `HOW YOUR MOVE IS ANSWERED: ${f.refutation}`);
  if (f.hangingAfter.length) {
    L.push(``, `LEFT UNDEFENDED AFTER YOUR MOVE: ${f.hangingAfter.join(", ")}.`);
  }

  if (f.alternatives.length) {
    L.push(``, `ENGINE OPTIONS HERE:`);
    f.alternatives.forEach((a, i) => L.push(`${i + 1}. ${a.san} (${a.eval})${a.line ? `: ${a.line}` : ""}`));
  }

  if (!f.best && !f.evalBefore) {
    L.push(``, `NOTE: no engine analysis was available for this position. Describe only what the move does; do not judge whether it is good.`);
  }

  L.push(
    ``,
    `MOVES YOU MAY NAME: ${f.allowedMoves.join(", ")}`,
    `Do not name any move outside that list. Do not describe any tactic not stated above.`,
    `The piece lists above are COMPLETE. Never mention a piece or a square that does not appear in them — if a square is not listed, it is empty.`,
    ``,
    `Write the explanation in no more than ${words} words, addressing the student as "you". Explain the idea behind the move and what to take away — do not simply restate the numbers.`,
    ``,
    `(Reference only, already analysed for you — do not re-analyse: ${f.fen})`,
  );

  return L.join("\n");
}

function reportPrompt(stats: GameReportStats) {
  // The deep profile is the difference between "you scored 87%" and "here is what you
  // are actually weak at". When it is present it leads the improvement sections; when it
  // is absent nothing may pretend it was there.
  const profileBlock = stats.selfProfile
    ? `

DEEP PROFILE — this is the most useful material here, so build sections (3) and (5) mainly from it, and name the specific positions and patterns rather than summarising them away. It is split by colour because playing White and playing Black are different skills:

${stats.selfProfile}

Rules for the block above, without exception: never quote a rate without the sample size next to it; where the evidence is marked thin or a range is wide, say so in plain words instead of stating it as fact; and describe the clock and position-type numbers as things the games show, never as what the student feels or fears.`
    : "";


  return `Write a detailed performance report for ${stats.username}, for them and their parent to read together.

Cover, in this order: (1) how they are playing overall, in words first and then with the numbers; (2) what they are doing WELL, with the figure that shows it; (3) their real weaknesses — the specific positions they keep reaching and misplaying, the tactics they keep missing, and when in a game their play drops off, as White and as Black separately; (4) their openings: which ones are going well and which are costing them, and what to do about each; (5) the top 3 things to practise next, each one a concrete exercise they could actually do this week, each tied to a weakness named in (3).

Every figure below comes from a Stockfish analysis of the player's own moves — cite them, and do not invent any others. Whenever you give a percentage, say in plain words what it means (for example, what a blunder is, or what "accuracy" is measuring) — assume the reader has never seen these numbers before.

Stats:
Games analysed: ${stats.totalGames}
Own moves analysed: ${stats.movesAnalyzed}
Overall accuracy: ${stats.overallAccuracy}%
Blunder rate: ${stats.blunderRate}% of moves
Mistake rate: ${stats.mistakeRate}% of moves
Inaccuracy rate: ${stats.inaccuracyRate}% of moves
Opening accuracy: ${stats.openingAccuracy}%
Middlegame accuracy: ${stats.middlegameAccuracy}%
Endgame accuracy: ${stats.endgameAccuracy}%
Openings they play most (grouped by family; "winRate" is a SCORE out of 100 where a draw counts a half. A null winRate means we deliberately withheld it because fewer than ${MIN_OPENING_GAMES} games is not enough to state a rate — say "not enough games yet" and NEVER estimate or infer a percentage for those): ${JSON.stringify(stats.topOpenings)}
Openings where they score lowest on accuracy (only families with at least ${MIN_OPENING_GAMES} games appear here at all; an EMPTY list means no single opening has been played enough times yet — say exactly that and do not fall back to naming one anyway): ${JSON.stringify(stats.weakestOpenings)}
Recurring problems behind their blunders: ${stats.tacticalPatternsMissed.join(", ") || "none clearly identified — say so rather than guessing"}${profileBlock}`;
}

function repertoirePrompt(description: string) {
  return `Write an opponent-specific briefing, 5-7 short paragraphs, for a student preparing against this player. Structure it as: (1) who this opponent is and how they play, (2) the concrete weaknesses to target, (3) their tactical profile — which motifs they miss and which they land, always with the sample size, and say plainly when the evidence is thin rather than rounding it into a claim, (4) their behavioural patterns — when their accuracy drops, which position types suit them least, how their losses end — stated as observed tendencies over their games and never as claims about what they feel, (5) walk through the recommended lines below in order, explaining what each one exploits and what to expect in reply, (6) a short "what to do if they deviate" note.

Every move, evaluation and percentage below came from Stockfish analysis of their real games — cite them, and do not introduce any move or claim that is not in this data. If a section is empty, say so plainly rather than inventing content. Address the student as "you" and refer to the opponent by their handle.

${description}`;
}

function openingPrompt(description: string) {
  return `Write a coaching guide to this opening, 5-7 short paragraphs, for a student learning to play it. Structure it as: (1) what this opening is about — the strategic idea and what you are trying to achieve with your colour, (2) walk through each major variation below in order, explaining the plans, typical pawn breaks and piece placements, and what to aim for in each, (3) which line is the most critical or testing and how to meet it, (4) the common mistakes to avoid and what to do if the opponent steers into a line not listed here.

Every move and evaluation below came from Stockfish analysis and the opening database — cite them, and do not introduce any move or claim that is not in this data. Address the student as "you". Keep it practical and encouraging, like a lesson.

${description}`;
}

// ---------------------------------------------------------------------------
// Provider: Anthropic (Claude)
// ---------------------------------------------------------------------------

let client: Anthropic | null = null;

function anthropicClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  client = new Anthropic({ apiKey });
  return client;
}

function textFromMessage(message: Anthropic.Messages.Message): Completion {
  const text =
    "content" in message
      ? message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("")
          .trim()
      : "";

  // Anthropic's spelling of `finish_reason: "length"`. Ignoring it hid the same bug
  // on this provider that it hid on the other two.
  return { text, truncated: message.stop_reason === "max_tokens" };
}

// ---------------------------------------------------------------------------
// Provider: OpenAI-compatible /chat/completions (default host: Groq)
// ---------------------------------------------------------------------------

const LLM_BASE_URL = (process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/+$/, "");
const LLM_MODEL = process.env.LLM_MODEL ?? "openai/gpt-oss-120b";
const LLM_TIMEOUT_MS = 2 * 60 * 1000;

/** GROQ_API_KEY is accepted as an alias so the default host works out of the box. */
function llmApiKey(): string | undefined {
  return process.env.LLM_API_KEY || process.env.GROQ_API_KEY || undefined;
}

/**
 * gpt-oss is a reasoning model: left alone it thinks at medium effort and
 * returns that thinking in a separate `reasoning` field. For a short coach
 * paragraph the thinking is pure latency, so effort is pinned low and the field
 * is switched off entirely.
 *
 * Both parameters are Groq extensions — other OpenAI-compatible hosts reject
 * unknown fields — so they are only sent when the host is actually Groq. Set
 * LLM_REASONING_EFFORT=none to suppress them there too.
 */
function reasoningParams(): Record<string, unknown> {
  const effort = process.env.LLM_REASONING_EFFORT ?? "low";
  if (effort === "none") return {};
  let host: string;
  try {
    host = new URL(LLM_BASE_URL).hostname;
  } catch {
    return {};
  }
  if (!(host === "groq.com" || host.endsWith(".groq.com"))) return {};
  return { reasoning_effort: effort, include_reasoning: false };
}

function llmBody(system: string, prompt: string, maxTokens: number, stream: boolean) {
  return JSON.stringify({
    model: LLM_MODEL,
    max_tokens: maxTokens,
    stream,
    ...reasoningParams(),
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
  });
}

async function llmFetch(system: string, prompt: string, maxTokens: number, stream: boolean) {
  const apiKey = llmApiKey();
  if (!apiKey) {
    throw new Error("LLM_API_KEY (or GROQ_API_KEY) is not configured");
  }

  const response = await pristineFetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    body: llmBody(system, prompt, maxTokens, stream),
  });

  if (!response.ok) {
    // The body carries the actual reason (bad model id, rate limit, bad key),
    // and without it every failure looks identical in the log.
    const detail = await response.text().catch(() => "");
    throw new Error(`LLM request failed: ${response.status} ${detail.slice(0, 300)}`);
  }
  return response;
}

/**
 * A completion, plus whether the model ran out of room mid-thought.
 *
 * `finish_reason: "length"` means the answer was CUT, not finished. Reading only
 * `message.content` and ignoring it is how a coach's guide reached a student ending
 * "...eroding your" — and, because the severed line was a half-written markdown table row,
 * with raw `|` pipes on screen underneath it.
 */
type Completion = { text: string; truncated: boolean };

async function llmChat(system: string, prompt: string, maxTokens: number): Promise<Completion> {
  const response = await llmFetch(system, prompt, maxTokens, false);
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };
  const choice = data.choices?.[0];
  return {
    text: (choice?.message?.content ?? "").trim(),
    truncated: choice?.finish_reason === "length",
  };
}

/**
 * Make a cut-off document end at a sensible place.
 *
 * A truncated answer is not wrong, it is unfinished — so the honest thing is to show the
 * part that IS finished and stop.
 *
 * The rule is DELIBERATELY conservative: drop only what is actually damaged. Two
 * over-corrections were written and rejected on the way here, both of which threw away
 * text the model had finished:
 *
 *   - popping every trailing line that starts with `|` deleted the whole table, not just
 *     the half-written row at the bottom of it;
 *   - popping the last line unconditionally erased the ENTIRE answer whenever the model
 *     wrote one long paragraph with no newline in it — the common case for the game
 *     report, which is three paragraphs of prose.
 *
 * So the last line is classified instead. A half-written table row or heading is
 * structurally broken and goes. A half-written sentence is trimmed back to its own last
 * full stop, which keeps every sentence before the cut.
 */
const TABLE_ROW = /^\s*\|/;
/** `| --- | :--: |` — the row that turns the line above it into a header. */
const TABLE_RULE = /^\s*\|[\s:|-]+\|?\s*$/;
/** Characters a finished line may legitimately end on. */
const SENTENCE_END = /[.!?:)\]`"']$/;

export function endCleanly({ text, truncated }: Completion): string {
  if (!truncated || !text) return text;

  const lines = text.split("\n");
  const tail = (lines.pop() ?? "").trimEnd();

  // Markdown structure cannot be repaired by trimming, so a broken row or heading is
  // dropped whole. Prose can: keep the sentences that completed before the cut.
  if (!TABLE_ROW.test(tail) && !tail.trimStart().startsWith("#")) {
    const stop = SENTENCE_END.test(tail)
      ? tail.length - 1
      : Math.max(tail.lastIndexOf(". "), tail.lastIndexOf("! "), tail.lastIndexOf("? "));
    if (stop >= 0) lines.push(tail.slice(0, stop + 1).trimEnd());
  }

  const last = () => lines[lines.length - 1] ?? "";

  // Blank lines, a heading that now introduces nothing, and an empty list bullet.
  while (
    lines.length &&
    (last().trim() === "" || last().trimStart().startsWith("#") || /^\s*[-*+]\s*$/.test(last()))
  ) {
    lines.pop();
  }

  // A table left with no data rows: drop the header block rather than render an empty
  // table, which reads as a mistake rather than as an ending. A table that still has at
  // least one row is kept intact.
  if (lines.length && TABLE_ROW.test(last())) {
    let start = lines.length - 1;
    while (start > 0 && TABLE_ROW.test(lines[start - 1] ?? "")) start--;
    const dataRows = lines.slice(start).filter((line) => !TABLE_RULE.test(line)).length;
    if (dataRows <= 1) {
      lines.length = start;
      while (lines.length && last().trim() === "") lines.pop();
    }
  }

  return lines.join("\n").trimEnd();
}

async function* llmChatStream(system: string, prompt: string, maxTokens: number): AsyncGenerator<string> {
  const response = await llmFetch(system, prompt, maxTokens, true);
  if (!response.body) throw new Error("LLM stream failed: empty body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are newline-delimited `data: {...}` lines. Only `delta.content`
    // is read — a reasoning model's `delta.reasoning` must never reach the user.
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const token = json.choices?.[0]?.delta?.content;
        if (token) yield token;
      } catch {
        // Partial frame — wait for the rest on the next chunk.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Provider: Ollama (self-hosted — reserved for the Phase 4 AI server)
// ---------------------------------------------------------------------------

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.1:8b";

/**
 * A local model writing a long dossier narrative can legitimately take minutes,
 * but it must not be able to take forever. `fetch` has no default timeout, so a
 * stalled Ollama left the profiling job awaiting a response that never arrived:
 * zero CPU, no error thrown, and the OpponentProfile row stuck on "processing"
 * with nothing able to move it.
 */
const OLLAMA_TIMEOUT_MS = 5 * 60 * 1000;

async function ollamaChat(system: string, prompt: string, maxTokens: number): Promise<Completion> {
  const response = await pristineFetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      options: { num_predict: maxTokens },
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status}`);
  }

  const data = (await response.json()) as { message?: { content?: string }; done_reason?: string };
  return {
    text: (data.message?.content ?? "").trim(),
    // Ollama's equivalent of finish_reason: "length".
    truncated: data.done_reason === "length",
  };
}

async function* ollamaChatStream(system: string, prompt: string, maxTokens: number): AsyncGenerator<string> {
  const response = await pristineFetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: true,
      options: { num_predict: maxTokens },
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Ollama stream failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        const json = JSON.parse(line) as { message?: { content?: string } };
        const token = json.message?.content;
        if (token) yield token;
      } catch {
        // Partial line — wait for the rest on the next chunk.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Provider: template (deterministic, offline, chess-safe)
// ---------------------------------------------------------------------------

/**
 * Deterministic move explanation. Restates verified facts only — it is the
 * no-AI-key path, and it must never be less trustworthy than the AI one.
 *
 * (The previous version printed centipawns as pawns, so a +0.35 edge was shown
 * to students as "+35".)
 */
function templateMoveExplanation(f: ChessMoveExplanationParams): string {
  const parts: string[] = [];

  const did: string[] = [];
  if (f.played.isCapture) did.push(`takes a ${f.played.captured ?? "piece"}`);
  if (f.played.isMate) did.push("delivers checkmate");
  else if (f.played.isCheck) did.push("gives check");
  if (f.played.isCastle) did.push("castles");
  if (f.played.isPromotion) did.push("promotes");
  const action = did.length ? ` — it ${did.join(" and ")}` : "";
  parts.push(`${f.played.san} moves your ${f.played.piece} from ${f.played.from} to ${f.played.to}${action}.`);

  if (f.forced) parts.push("It was the only legal move in the position.");

  if (f.played.motifs.length) {
    parts.push(`It creates ${f.played.motifs.map((m) => MOTIF_PHRASE[m] ?? m).join(" and ")}.`);
  }

  if (f.classificationLabel && f.evalAfter) {
    parts.push(
      `The engine rates it ${f.classificationLabel.toLowerCase()}${f.symbol ? ` (${f.symbol})` : ""}, with the position at ${f.evalAfter} from your side${f.cpLoss ? ` — ${f.cpLoss} centipawns worse than the best move` : ""}.`,
    );
  } else if (f.evalAfter) {
    parts.push(`The position stands at ${f.evalAfter} from your side afterwards.`);
  }

  if (f.playedWasBest) {
    parts.push("This was the engine's first choice here.");
  } else if (f.best) {
    parts.push(
      `The engine preferred ${f.best.san}${f.best.line ? ` (${f.best.line})` : ""}.` +
        (f.missedMotifs.length
          ? ` That move sets up ${f.missedMotifs.map((x) => MOTIF_PHRASE[x.motif] ?? x.motif).join(" and ")}.`
          : ""),
    );
  }

  if (f.refutation) parts.push(`The critical reply is ${f.refutation}.`);
  if (f.hangingAfter.length) {
    parts.push(`Watch out: after this move your ${f.hangingAfter.join(" and your ")} ${f.hangingAfter.length > 1 ? "are" : "is"} undefended.`);
  }
  if (!f.best && !f.evalBefore) {
    parts.push("No engine analysis was available for this position, so this describes the move rather than judging it.");
  }

  return parts.join(" ");
}

function templateReportNarrative(stats: GameReportStats): string {
  const phases: Array<[string, number]> = [
    ["opening", stats.openingAccuracy],
    ["middlegame", stats.middlegameAccuracy],
    ["endgame", stats.endgameAccuracy],
  ];
  const best = [...phases].sort((a, b) => b[1] - a[1])[0];
  const worst = [...phases].sort((a, b) => a[1] - b[1])[0];
  const weakest = stats.weakestOpenings[0];

  const p1 = `Across ${stats.totalGames} games (${stats.movesAnalyzed} of your own moves analysed), you played at ${stats.overallAccuracy}% accuracy, with a ${stats.blunderRate}% blunder rate, ${stats.mistakeRate}% mistakes and ${stats.inaccuracyRate}% inaccuracies.`;
  const p2 = `Your ${best[0]} was your strongest phase (${best[1]}%), while your ${worst[0]} (${worst[1]}%) is where the most points slipped — that is the area to focus on.`;
  const p3 = weakest
    ? `Your lowest-scoring opening was ${weakest.name} (${weakest.accuracy}%); reviewing that line would pay off.${stats.tacticalPatternsMissed.length ? ` Recurring themes behind your blunders: ${stats.tacticalPatternsMissed.join(", ")}.` : ""}`
    : `Keep drilling tactics to bring the blunder rate down.`;

  return [p1, p2, p3].join("\n");
}

/**
 * Deterministic repertoire prose. Every sentence restates data that engine
 * analysis already produced, so the free provider never invents chess.
 */
function templateRepertoireNarrative(params: OpponentRepertoireParams): string {
  const { handle, colorToPlay, gamesAnalyzed, lines, topWeakness, noveltyCount, transpositionCount } = params;

  const p1 = `Preparation against ${handle}, playing ${colorToPlay}. This briefing is built from ${gamesAnalyzed} of their recent games, weighted so their current form counts most.`;

  const p2 = topWeakness
    ? `Their clearest recurring problem: after ${topWeakness.line || "the opening moves"} they usually answer ${topWeakness.move}, which Stockfish scores at only ${topWeakness.accuracy}% accuracy${topWeakness.clock !== null ? `, and they spend about ${topWeakness.clock}s on it` : ""}. That is the position to aim for.`
    : `No single position stood out as a clear weakness in the games analysed — play your own strongest lines rather than forcing a target.`;

  const p3 = lines.length
    ? `Recommended lines, strongest first:\n${lines
        .map((l, i) => `${i + 1}. ${l.moves.join(" ")} — ${l.rationale}`)
        .join("\n")}`
    : `Not enough repertoire data to recommend specific lines.`;

  const p4 = `This plan includes ${noveltyCount} mined ${noveltyCount === 1 ? "novelty" : "novelties"} (engine-approved but rarely played by humans) and ${transpositionCount} transposition ${transpositionCount === 1 ? "bypass" : "bypasses"}. If they deviate from the lines above, fall back on the evaluations given rather than improvising — anything not listed here was not analysed.`;

  return [p1, p2, p3, p4].join("\n\n");
}

export type OpponentRepertoireParams = {
  handle: string;
  colorToPlay: string;
  gamesAnalyzed: number;
  /** Pre-rendered artifact description (see second/repertoire.ts). */
  description: string;
  lines: Array<{ moves: string[]; rationale: string }>;
  topWeakness: { line: string; move: string; accuracy: number; clock: number | null } | null;
  noveltyCount: number;
  transpositionCount: number;
};

// ---------------------------------------------------------------------------
// Public API (stable across providers)
// ---------------------------------------------------------------------------

/**
 * Output budgets.
 *
 * `endCleanly` makes a cut-off answer end tidily; it cannot put back what was never
 * written. These are sized so truncation is rare rather than merely survivable.
 *
 * The guide and briefing prompts both ask for "5-7 short paragraphs" that walk through
 * every variation in turn — comfortably 700-900 words, or ~1300 tokens, before the
 * markdown tables. They were capped at 1600, which is why a real student's opening
 * guide stopped in the middle of a table row. The report asks for three paragraphs of
 * prose with figures and was capped at 600.
 *
 * Local budgets stay lower on purpose: a 2B model on this 2-vCPU box spends real seconds
 * per token and competes with Stockfish for the same cores.
 */
const LONG_FORM_TOKENS = { local: 2000, hosted: 3200 };
// The report now carries a full self-profile — weaknesses, tactics and behaviour, split
// by colour — so the narrative is closer in size to the dossier briefing than to the four
// paragraphs it used to be. Sized against LONG_FORM_TOKENS for that reason.
const REPORT_TOKENS = { local: 1600, hosted: 3200 };

/** Local models are token-bound; hosted ones are not. See moveExplanationPrompt. */
const LOCAL_EXPLANATION = { words: 80, maxTokens: 200 };
const HOSTED_EXPLANATION = { words: 150, maxTokens: 400 };

export async function explainChessMove(params: ChessMoveExplanationParams): Promise<string> {
  const provider = activeProvider();

  if (provider === "template") return templateMoveExplanation(params);
  if (provider === "ollama") {
    const { words, maxTokens } = LOCAL_EXPLANATION;
    return endCleanly(await ollamaChat(MOVE_EXPLANATION_SYSTEM, moveExplanationPrompt(params, words), maxTokens));
  }

  const { words, maxTokens } = HOSTED_EXPLANATION;
  if (provider === "openai-compatible") {
    return endCleanly(await llmChat(MOVE_EXPLANATION_SYSTEM, moveExplanationPrompt(params, words), maxTokens));
  }

  const message = await anthropicClient().messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system: MOVE_EXPLANATION_SYSTEM,
    messages: [{ role: "user", content: moveExplanationPrompt(params, words) }],
  });
  return endCleanly(textFromMessage(message));
}

export async function* streamChessMoveExplanation(params: ChessMoveExplanationParams): AsyncGenerator<string> {
  const provider = activeProvider();

  if (provider === "template") {
    yield templateMoveExplanation(params);
    return;
  }
  if (provider === "ollama") {
    const { words, maxTokens } = LOCAL_EXPLANATION;
    yield* ollamaChatStream(MOVE_EXPLANATION_SYSTEM, moveExplanationPrompt(params, words), maxTokens);
    return;
  }

  const { words, maxTokens } = HOSTED_EXPLANATION;
  if (provider === "openai-compatible") {
    yield* llmChatStream(MOVE_EXPLANATION_SYSTEM, moveExplanationPrompt(params, words), maxTokens);
    return;
  }

  const stream = anthropicClient().messages.stream({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system: MOVE_EXPLANATION_SYSTEM,
    messages: [{ role: "user", content: moveExplanationPrompt(params, words) }],
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}

export async function generateGameReportNarrative(stats: GameReportStats): Promise<string> {
  const provider = activeProvider();

  if (provider === "template") return templateReportNarrative(stats);
  if (provider === "ollama") {
    return endCleanly(await ollamaChat(REPORT_SYSTEM, reportPrompt(stats), REPORT_TOKENS.local));
  }
  if (provider === "openai-compatible") {
    return endCleanly(await llmChat(REPORT_SYSTEM, reportPrompt(stats), REPORT_TOKENS.hosted));
  }

  const message = await anthropicClient().messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: REPORT_TOKENS.local,
    system: REPORT_SYSTEM,
    messages: [{ role: "user", content: reportPrompt(stats) }],
  });
  return endCleanly(textFromMessage(message));
}

/**
 * Annotate an opponent-specific repertoire (Phase 4 Digital Second).
 *
 * The lines themselves are chosen by engine analysis before this is called —
 * the AI layer only explains them. On any provider failure the deterministic
 * template output is returned rather than throwing, so a dossier is always
 * produced.
 */
export async function generateOpponentRepertoire(params: OpponentRepertoireParams): Promise<string> {
  const provider = activeProvider();

  if (provider === "template") return templateRepertoireNarrative(params);

  try {
    if (provider === "ollama") {
      const text = endCleanly(await ollamaChat(REPERTOIRE_SYSTEM, repertoirePrompt(params.description), LONG_FORM_TOKENS.local));
      return text || templateRepertoireNarrative(params);
    }

    if (provider === "openai-compatible") {
      const text = endCleanly(await llmChat(REPERTOIRE_SYSTEM, repertoirePrompt(params.description), LONG_FORM_TOKENS.hosted));
      return text || templateRepertoireNarrative(params);
    }

    const message = await anthropicClient().messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: LONG_FORM_TOKENS.local,
      system: REPERTOIRE_SYSTEM,
      messages: [{ role: "user", content: repertoirePrompt(params.description) }],
    });
    return endCleanly(textFromMessage(message)) || templateRepertoireNarrative(params);
  } catch (error) {
    console.error("[second] repertoire generation failed, using template:", error);
    return templateRepertoireNarrative(params);
  }
}

export type OpeningGuideParams = {
  name: string;
  colorToPlay: string;
  eco: string | null;
  variationCount: number;
  /** Engine-best line for our colour (SAN), if one was found. */
  bestLine: string[] | null;
  /** Pre-rendered artifact description (see opening/describeOpening.ts). */
  description: string;
};

/**
 * Deterministic opening-guide prose. Every sentence restates data the engine and
 * opening database already produced, so the free provider never invents chess.
 */
function templateOpeningGuide(params: OpeningGuideParams): string {
  const { name, colorToPlay, eco, variationCount, bestLine } = params;

  const p1 = `A guide to the ${name}${eco ? ` (ECO ${eco})` : ""}, from your side as ${colorToPlay}. This repertoire covers ${variationCount} of its main variations, each played out to roughly 15 moves with engine analysis.`;

  const p2 = bestLine && bestLine.length
    ? `Your strongest line here, by the engine's evaluation, is ${bestLine.join(" ")}. Learn this one first — it is the most reliable way to reach a good position.`
    : `Work through the variations below in order; each has been checked by the engine to a playable depth.`;

  const p3 = `Each variation below is a real, engine-approved line. Where a line is marked as leaving popular human play, that is the point at which you are on your own theory and should understand the ideas rather than memorise moves. If your opponent plays something not covered here, fall back on the evaluations given and the general plans of the opening.`;

  return [p1, p2, p3].join("\n\n");
}

/**
 * Author a coaching guide for an opening (Phase 5 Opening Trainer).
 *
 * The lines are chosen by engine analysis before this is called — the AI layer
 * only explains them. On any provider failure the deterministic template output is
 * returned rather than throwing, so a repertoire is always produced.
 */
export async function generateOpeningGuide(params: OpeningGuideParams): Promise<string> {
  const provider = activeProvider();

  if (provider === "template") return templateOpeningGuide(params);

  try {
    if (provider === "ollama") {
      const text = endCleanly(await ollamaChat(OPENING_SYSTEM, openingPrompt(params.description), LONG_FORM_TOKENS.local));
      return text || templateOpeningGuide(params);
    }

    if (provider === "openai-compatible") {
      const text = endCleanly(await llmChat(OPENING_SYSTEM, openingPrompt(params.description), LONG_FORM_TOKENS.hosted));
      return text || templateOpeningGuide(params);
    }

    const message = await anthropicClient().messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: LONG_FORM_TOKENS.local,
      system: OPENING_SYSTEM,
      messages: [{ role: "user", content: openingPrompt(params.description) }],
    });
    return endCleanly(textFromMessage(message)) || templateOpeningGuide(params);
  } catch (error) {
    console.error("[opening] guide generation failed, using template:", error);
    return templateOpeningGuide(params);
  }
}
