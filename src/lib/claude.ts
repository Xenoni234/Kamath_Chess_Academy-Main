import Anthropic from "@anthropic-ai/sdk";

/**
 * AI narration for move explanations and report narratives.
 *
 * The provider is pluggable behind a stable interface so the calling routes
 * (analysis explain, report generation) never change:
 *   - "anthropic" — Claude API (needs ANTHROPIC_API_KEY). Best chess quality.
 *   - "ollama"    — a self-hosted Ollama server (OLLAMA_URL). Reserved for the
 *                   Phase 4 AI server; opt-in only.
 *   - "template"  — deterministic, offline prose built from the engine numbers.
 *                   Free, and chess-safe (it never invents tactics).
 *
 * Selection: AI_PROVIDER wins if set; otherwise Anthropic when a key is present,
 * else the template fallback. Ollama is never auto-selected.
 */
type AiProvider = "anthropic" | "ollama" | "template";

function activeProvider(): AiProvider {
  const explicit = process.env.AI_PROVIDER?.toLowerCase();
  if (explicit === "anthropic" || explicit === "ollama" || explicit === "template") {
    return explicit;
  }
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "template";
}

export type ChessMoveExplanationParams = {
  fen: string;
  playerMoveSan: string;
  bestMoveSan: string;
  evaluation: number;
  topMoves: Array<{ san: string; evaluation: number; continuation: string }>;
  isGoodMove: boolean;
};

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
  return true;
}

// ---------------------------------------------------------------------------
// Prompts (shared by the Anthropic and Ollama providers)
// ---------------------------------------------------------------------------

const MOVE_EXPLANATION_SYSTEM = "You are a chess coach explaining moves to a student.";
const REPORT_SYSTEM = "You are a chess coach writing a concise performance report for a student.";
const REPERTOIRE_SYSTEM =
  "You are a chess second preparing a player for a specific opponent. You annotate lines that have already been chosen by engine analysis — never invent moves, never contradict the supplied evaluations.";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

function moveExplanationPrompt(params: ChessMoveExplanationParams) {
  const alternatives = params.topMoves
    .slice(0, 3)
    .map((move, index) => `${index + 1}. ${move.san} (${move.evaluation}): ${move.continuation}`)
    .join("\n");

  return `Given this position and move choice, explain in 2-4 sentences and no more than 80 words why ${params.bestMoveSan} is correct. Mention the relevant tactics or plans, and address the student as "you".

FEN: ${params.fen}
Your move: ${params.playerMoveSan}
Best move: ${params.bestMoveSan}
Evaluation: ${params.evaluation}
Was your move good: ${params.isGoodMove ? "yes" : "no"}
Top alternatives:
${alternatives}`;
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
  return `Write an opponent-specific opening repertoire briefing, 4-6 short paragraphs, for a student preparing against this player. Structure it as: (1) who this opponent is and how they play, (2) the concrete weaknesses to target, (3) walk through the recommended lines below in order, explaining what each one exploits and what to expect in reply, (4) a short "what to do if they deviate" note.

Every move, evaluation and percentage below came from Stockfish analysis of their real games — cite them, and do not introduce any move or claim that is not in this data. If a section is empty, say so plainly rather than inventing content. Address the student as "you" and refer to the opponent by their handle.

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
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
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
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
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

function formatEval(value: number): string {
  if (!Number.isFinite(value)) return "unclear";
  return value > 0 ? `+${value}` : `${value}`;
}

function templateMoveExplanation(params: ChessMoveExplanationParams): string {
  const evalStr = formatEval(params.evaluation);
  if (params.isGoodMove) {
    return `${params.playerMoveSan} is a sound choice — the position stays in good shape (evaluation ${evalStr}). The engine's top pick here was ${params.bestMoveSan}.`;
  }
  const alternatives = params.topMoves
    .slice(0, 2)
    .map((move) => move.san)
    .filter(Boolean)
    .join(" or ");
  const also = alternatives ? `, with ${alternatives} also worth a look` : "";
  return `${params.playerMoveSan} isn't the strongest here — the engine prefers ${params.bestMoveSan} (evaluation ${evalStr})${also}. Try to spot that idea in similar positions.`;
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

export async function explainChessMove(params: ChessMoveExplanationParams): Promise<string> {
  const provider = activeProvider();

  if (provider === "template") return templateMoveExplanation(params);
  if (provider === "ollama") {
    return ollamaChat(MOVE_EXPLANATION_SYSTEM, moveExplanationPrompt(params), 200);
  }

  const message = await anthropicClient().messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 200,
    system: MOVE_EXPLANATION_SYSTEM,
    messages: [{ role: "user", content: moveExplanationPrompt(params) }],
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
    yield* ollamaChatStream(MOVE_EXPLANATION_SYSTEM, moveExplanationPrompt(params), 200);
    return;
  }

  const stream = anthropicClient().messages.stream({
    model: ANTHROPIC_MODEL,
    max_tokens: 200,
    system: MOVE_EXPLANATION_SYSTEM,
    messages: [{ role: "user", content: moveExplanationPrompt(params) }],
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
