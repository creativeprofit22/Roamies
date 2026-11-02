// Webview telemetry (schema v1, see docs/telemetry.md): start a step, end it, record an event.
// Events are batched every second and handed to the sidecar through the host; the page writes no files.
(() => {
  const SCHEMA = 1, FLUSH_MS = 1000, MAX_QUEUE = 500;
  const RID = /^[0-9a-f]{32}$/;
  const hex = (bytes) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  const rid = (v) => (typeof v === 'string' && RID.test(v) ? v : null);
  let on = true, queue = [], timer = null;

  const flush = () => {
    timer = null;
    if (!queue.length) return;
    const events = queue; queue = [];
    const invoke = window.__TAURI__?.core?.invoke;
    invoke?.('sidecar_send', { msg: { type: 'telemetry', events } }).catch(() => {});
  };
  const push = (e) => {
    if (!on) return;
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(e);
    timer ??= setTimeout(flush, FLUSH_MS);
  };
  const event = (kind, step, fields) => ({
    schema: SCHEMA, ts: Date.now(), app_version: '', os: '',
    request_id: null, step_id: hex(8), parent_step_id: null, kind, step, component: 'webview',
    duration_ms: null, outcome: null, error_code: null, attrs: {}, ...fields,
  });
  const parentId = (p) => (p && typeof p === 'object' ? p.id : p) ?? null;

  window.RoamiesTelemetry = {
    newRequestId: () => hex(16),
    get enabled() { return on; },
    setEnabled(v) { on = !!v; if (!on) queue = []; },
    start(step, { requestId = null, parent = null, attrs = {} } = {}) {
      const s = { id: hex(8), step, requestId: rid(requestId), parent: parentId(parent), t0: performance.now() };
      push(event('start', step, { step_id: s.id, request_id: s.requestId, parent_step_id: s.parent, attrs }));
      return s;
    },
    end(s, { outcome = 'ok', errorCode = null, attrs = {} } = {}) {
      if (!s) return;
      const duration_ms = Math.round((performance.now() - s.t0) * 1000) / 1000;
      push(event('end', s.step, { step_id: s.id, request_id: s.requestId, parent_step_id: s.parent, duration_ms, outcome, error_code: errorCode, attrs }));
    },
    // A finished interval from two performance marks (Performance API), sent as a start/end pair.
    measure(step, startMark, endMark, { requestId = null, parent = null, outcome = 'ok', errorCode = null, attrs = {} } = {}) {
      let m = null;
      try { m = performance.measure(`${step}:${startMark}`, startMark, endMark); } catch { m = null; }
      performance.clearMarks(startMark); performance.clearMarks(endMark);
      if (!m) return;
      performance.clearMeasures(m.name);
      if (!on) return;
      const id = hex(8), request_id = rid(requestId), parent_step_id = parentId(parent);
      const ts = Math.round(performance.timeOrigin + m.startTime);
      push(event('start', step, { ts, step_id: id, request_id, parent_step_id, attrs }));
      const duration_ms = Math.round(m.duration * 1000) / 1000;
      push(event('end', step, { ts: Math.round(ts + m.duration), step_id: id, request_id, parent_step_id, duration_ms, outcome, error_code: errorCode, attrs }));
    },
    record(step, { requestId = null, parent = null, attrs = {} } = {}) {
      push(event('event', step, { request_id: rid(requestId), parent_step_id: parentId(parent), attrs }));
    },
    flush,
  };
  addEventListener('pagehide', flush);
})();
