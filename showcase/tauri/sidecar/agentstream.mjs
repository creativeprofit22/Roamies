// gg-agent also rejects a stream's result promise when a request fails. Nothing awaits it while we iterate,
// so Node treats it as unhandled and exits. The error still reaches the caller through the events.
export function agentEvents(stream) {
  const events = stream[Symbol.asyncIterator](); // claim the events first so then() doesn't drain them
  stream.then(undefined, () => {});
  return events;
}
