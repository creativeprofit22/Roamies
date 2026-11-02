// The Claude Code user-agent for Anthropic agents; other providers get none.
// Called for every request: gg-core caches it in memory, and caches its 2.1.88 fallback for only 5 minutes after a
// failed lookup, so an early failure (offline at launch) heals without a restart.
export async function agentUserAgent(provider, lookup) {
  if (provider !== 'anthropic') return undefined;
  try { return await lookup(); } catch { return undefined; }
}
