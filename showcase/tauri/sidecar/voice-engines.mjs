// Voice engine registry, shared with the host (src-tauri/src/voice/engines.rs reads the same JSON).
// Engine facts live in voice-engines.json; this file only turns them into download manifests and picks one.
import registry from '../src-tauri/voice-engines.json' with { type: 'json' };

export const ENGINES = registry.engines;
export const DEFAULT_ENGINE = registry.default;
export const engine = (id) => ENGINES.find((e) => e.id === id) ?? null;

// The download manifest voice-model.mjs expects: folder name, marker revision and per-file URLs.
export function manifestFor(e) {
  const { dir, rev, base, files } = e.model;
  return { name: dir, rev, files: files.map(({ name, size, sha256 }) => ({ name, sha256, size, url: new URL(name, base).href })) };
}

// Configured engine if its model is verified, else the first ready one in registry order; none ready
// means the configured one, not ready (the press reports `unavailable` and its download is offered).
export function chooseEngine({ configured, ready }) {
  const want = engine(configured)?.id ?? DEFAULT_ENGINE;
  if (ready(want)) return { id: want, ready: true };
  const other = ENGINES.find((e) => ready(e.id));
  return other ? { id: other.id, ready: true } : { id: want, ready: false };
}

// Shadow mode's candidate: the first other engine in registry order, with whether its model is verified.
// None when the registry has a single engine.
export function shadowEngine({ active, ready }) {
  const other = ENGINES.find((e) => e.id !== active);
  return other ? { id: other.id, ready: !!ready(other.id) } : null;
}

// voice_config's `shadow` field: only when switched on, the primary is ready and the other model is
// already verified. Shadow mode never starts a download.
export function shadowPayload({ on, active, ready, dirOf }) {
  if (!on || !active.ready) return null;
  const s = shadowEngine({ active: active.id, ready });
  return s?.ready ? { engine: s.id, model: dirOf(s.id), ready: true } : null;
}
