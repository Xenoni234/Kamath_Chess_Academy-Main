import Anthropic from "@anthropic-ai/sdk";
import { pristineFetch } from "@/lib/pristineFetch";
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
  topOpenings: Array<{ name: string; winRate: number; count: number }>;
  weakestOpenings: Array<{ name: string; accuracy: number }>;
  tacticalPatternsMissed: string[];
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
const REPORT_SYSTEM = "You are a chess coach writing a concise performance report for a student.";
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
  return `Write a 3-paragraph performance report for ${stats.username}. Include an overall assessment with numbers, key strengths, and the top 2-3 improvement areas with actionable advice. Every figure below comes from a Stockfish analysis of the player's own moves — cite them, and do not invent any others.

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
Top openings: ${JSON.stringify(stats.topOpenings)}
Weakest openings: ${JSON.stringify(stats.weakestOpenings)}
Recurring problems behind their blunders: ${stats.tacticalPatternsMissed.join(", ") || "none clearly identified — say so rather than guessing"}`;
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

function textFromMessage(message: Anthropic.Messages.Message) {
  if ("content" in message) {
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
  }
  return "";
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

async function llmChat(system: string, prompt: string, maxTokens: number): Promise<string> {
  const response = await llmFetch(system, prompt, maxTokens, false);
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (data.choices?.[0]?.message?.content ?? "").trim();
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

async function ollamaChat(system: string, prompt: string, maxTokens: number): Promise<string> {
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

  const data = (await response.json()) as { message?: { content?: string } };
  return (data.message?.content ?? "").trim();
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

/** Local models are token-bound; hosted ones are not. See moveExplanationPrompt. */
const LOCAL_EXPLANATION = { words: 80, maxTokens: 200 };
const HOSTED_EXPLANATION = { words: 150, maxTokens: 400 };

export async function explainChessMove(params: ChessMoveExplanationParams): Promise<string> {
  const provider = activeProvider();

  if (provider === "template") return templateMoveExplanation(params);
  if (provider === "ollama") {
    const { words, maxTokens } = LOCAL_EXPLANATION;
    return ollamaChat(MOVE_EXPLANATION_SYSTEM, moveExplanationPrompt(params, words), maxTokens);
  }

  const { words, maxTokens } = HOSTED_EXPLANATION;
  if (provider === "openai-compatible") {
    return llmChat(MOVE_EXPLANATION_SYSTEM, moveExplanationPrompt(params, words), maxTokens);
  }

  const message = await anthropicClient().messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system: MOVE_EXPLANATION_SYSTEM,
    messages: [{ role: "user", content: moveExplanationPrompt(params, words) }],
  });
  return textFromMessage(message);
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
    return ollamaChat(REPORT_SYSTEM, reportPrompt(stats), 400);
  }
  if (provider === "openai-compatible") {
    return llmChat(REPORT_SYSTEM, reportPrompt(stats), 600);
  }

  const message = await anthropicClient().messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 400,
    system: REPORT_SYSTEM,
    messages: [{ role: "user", content: reportPrompt(stats) }],
  });
  return textFromMessage(message);
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
      const text = await ollamaChat(REPERTOIRE_SYSTEM, repertoirePrompt(params.description), 1200);
      return text || templateRepertoireNarrative(params);
    }

    if (provider === "openai-compatible") {
      const text = await llmChat(REPERTOIRE_SYSTEM, repertoirePrompt(params.description), 1600);
      return text || templateRepertoireNarrative(params);
    }

    const message = await anthropicClient().messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1200,
      system: REPERTOIRE_SYSTEM,
      messages: [{ role: "user", content: repertoirePrompt(params.description) }],
    });
    return textFromMessage(message) || templateRepertoireNarrative(params);
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
      const text = await ollamaChat(OPENING_SYSTEM, openingPrompt(params.description), 1200);
      return text || templateOpeningGuide(params);
    }

    if (provider === "openai-compatible") {
      const text = await llmChat(OPENING_SYSTEM, openingPrompt(params.description), 1600);
      return text || templateOpeningGuide(params);
    }

    const message = await anthropicClient().messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1200,
      system: OPENING_SYSTEM,
      messages: [{ role: "user", content: openingPrompt(params.description) }],
    });
    return textFromMessage(message) || templateOpeningGuide(params);
  } catch (error) {
    console.error("[opening] guide generation failed, using template:", error);
    return templateOpeningGuide(params);
  }
}
