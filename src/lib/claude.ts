import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

/**
 * Lazily construct the SDK client. Building it at module scope meant every
 * route that merely imported this file blew up when ANTHROPIC_API_KEY was
 * unset; now only the calls that actually need Claude fail, and with a message
 * that says why.
 */
/**
 * Whether Claude can be called at all. Routes that stream should check this
 * first — once a stream is open there is no way to send a status code, so a
 * missing key would surface to the browser as a dropped connection.
 */
export function isClaudeConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function anthropicClient(): Anthropic {
  if (client) return client;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  client = new Anthropic({ apiKey });
  return client;
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

const MOVE_EXPLANATION_SYSTEM = "You are a chess coach explaining moves to a student.";
const MODEL = "claude-sonnet-4-6";

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

export async function explainChessMove(params: ChessMoveExplanationParams): Promise<string> {
  const message = await anthropicClient().messages.create({
    model: MODEL,
    max_tokens: 200,
    system: MOVE_EXPLANATION_SYSTEM,
    messages: [{ role: "user", content: moveExplanationPrompt(params) }],
  });

  return textFromMessage(message);
}

export async function* streamChessMoveExplanation(params: ChessMoveExplanationParams): AsyncGenerator<string> {
  const stream = anthropicClient().messages.stream({
    model: MODEL,
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
  const message = await anthropicClient().messages.create({
    model: MODEL,
    max_tokens: 400,
    system: "You are a chess coach writing a concise performance report for a student.",
    messages: [
      {
        role: "user",
        content: `Write a 3-paragraph performance report for ${stats.username}. Include an overall assessment with numbers, key strengths, and the top 2-3 improvement areas with actionable advice. Every figure below comes from a Stockfish analysis of the player's own moves — cite them, and do not invent any others.

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
Recurring problems behind their blunders: ${stats.tacticalPatternsMissed.join(", ") || "none clearly identified — say so rather than guessing"}`,
      },
    ],
  });

  return textFromMessage(message);
}
