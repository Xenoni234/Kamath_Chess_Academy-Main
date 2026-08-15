/**
 * The real `fetch`, captured at module load.
 *
 * Stockfish's Emscripten runtime replaces `globalThis.fetch` with its own
 * asset loader while it boots. `serverEngine` restores the global afterwards,
 * but that restore is not a guarantee for anything running *concurrently*:
 * the profiling job boots a pool of engines while it is also talking to the
 * Lichess explorer and the AI provider, so a network call can land in the
 * window where the global is still the engine's version. The symptom is
 * `TypeError: fetch is not a function` from somewhere with no connection to
 * chess at all — observed killing dossier narration, which then silently fell
 * back to template prose.
 *
 * Anchoring every server-side network call to a reference taken before any
 * engine exists removes the timing question entirely. Import this rather than
 * calling the global `fetch` in any module that can run alongside the engine.
 *
 * Capture happens on first import. `serverEngine` imports it at the top level,
 * and engines only boot when a search is requested, so the reference is always
 * taken before the first clobber.
 */
export const pristineFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);
