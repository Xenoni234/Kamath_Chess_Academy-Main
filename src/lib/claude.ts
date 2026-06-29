import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

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
  overallAccuracy: number;
  blunderRate: number;
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

function textFromMessage(message: Awaited<ReturnType<typeof anthropic.messages.create>>) {
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
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 200,
    system: MOVE_EXPLANATION_SYSTEM,
    messages: [{ role: "user", content: moveExplanationPrompt(params) }],
  });

  return textFromMessage(message);
}

export async function* streamChessMoveExplanation(params: ChessMoveExplanationParams): AsyncGenerator<string> {
  const stream = anthropic.messages.stream({
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
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: "You are a chess coach writing a concise performance report for a student.",
    messages: [
      {
        role: "user",
        content: `Write a 3-paragraph performance report for ${stats.username}. Include an overall assessment with numbers, key strengths, and the top 2-3 improvement areas with actionable advice.

Stats:
Total games: ${stats.totalGames}
Overall accuracy: ${stats.overallAccuracy}
Blunder rate: ${stats.blunderRate}
Opening accuracy: ${stats.openingAccuracy}
Middlegame accuracy: ${stats.middlegameAccuracy}
Endgame accuracy: ${stats.endgameAccuracy}
Top openings: ${JSON.stringify(stats.topOpenings)}
Weakest openings: ${JSON.stringify(stats.weakestOpenings)}
Tactical patterns missed: ${stats.tacticalPatternsMissed.join(", ") || "None identified"}`,
      },
    ],
  });

  return textFromMessage(message);
}
