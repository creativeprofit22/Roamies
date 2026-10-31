// Tauri host bridge. The shell calls __roamiePtr(x, y) with the real cursor each frame and
// __roamieHost(msg) with messages from the sidekick's brain (the gg-agent sidecar).
// The page answers through set_hot (click-through), set_typing (keyboard focus) and sidecar_send.
// A no-op outside Tauri.
(() => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;
  const send = (msg) => invoke('sidecar_send', { msg }).catch(() => {});
  const typing = (on) => invoke('set_typing', { on }).catch(() => {});

  window.__roamieSafe = (s) => Roamie.setSafe?.(s);
  let hot = null;
  window.__roamiePtr = (x, y) => {
    if (!window.Roamie?.ptr) return;
    const h = Roamie.ptr(x, y);
    if (h !== hot) { hot = h; invoke('set_hot', { hot: h }).catch(() => { hot = null; }); }
  };

  let agent = null;
  const getAgent = () => (agent ??= Roamie.tiles?.find((t) => t.creature?.agent)?.creature.agent ?? null);

  // ---------- typing into an input bubble ----------
  // A real (invisible) input collects keys, so paste, IME and key repeat all just work.
  const field = document.createElement('input');
  Object.assign(field.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  field.setAttribute('aria-label', 'Message for Sidekick');
  field.autocomplete = 'off'; field.spellcheck = false;
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(field));
  if (document.body) document.body.appendChild(field);

  let ask = null;
  const focusField = () => { typing(true); setTimeout(() => field.focus(), 30); ask?.h.focus(true); };
  const finishAsk = (text) => {
    if (!ask) return;
    const { id, h } = ask;
    ask = null;
    field.blur(); field.value = '';
    typing(false);
    h.close();
    if (id) send({ type: 'answer', id, text });
  };
  const openAsk = (m) => {
    const a = getAgent();
    if (!a) return;
    if (ask) finishAsk(null);
    endTalk();
    field.value = '';
    field.type = m.mask ? 'password' : 'text';
    // The question goes in the placeholder, so the bubble reads "Paste your API key…" until you type.
    const h = a.prompt({ placeholder: m.prompt || m.placeholder || '', mask: m.mask, onPress: focusField });
    ask = { id: m.id, h };
    focusField();
  };
  field.addEventListener('input', () => ask?.h.set(field.value));
  field.addEventListener('keydown', (e) => {
    if (!ask) return;
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finishAsk(field.value); }
    else if (e.key === 'Escape') { e.preventDefault(); finishAsk(null); }
  });
  field.addEventListener('blur', () => ask?.h.focus(false));

  // ---------- agent events -> body language ----------
  let speech = null, thought = null, nextMood = null, listen = null, heard = null;
  const jobs = [];
  let current = null;
  const MOODS = { hype: 'happy', wave: 'happy', upset: 'annoyed', remind: 'concerned', motivate: 'determined' };
  const endTalk = () => { speech?.end(); thought?.end(); speech = thought = null; };

  async function playTools() {
    if (current) return;
    while (jobs.length) {
      // Falling behind (lots of quick parallel calls): skip ones that already finished.
      while (jobs.length > 2 && jobs[0].result !== undefined) jobs.shift();
      const job = jobs.shift(), a = getAgent();
      if (!a) break;
      current = job;
      job.h = a.tool(job.anim.tool, { variant: job.anim.variant, detail: job.anim.detail, live: true, rect: job.target, rectName: job.targetName });
      if (job.result !== undefined) job.h.done(!job.result);
      await job.h.closed;
      current = null;
    }
  }
  const settle = (id, isError) => {
    const job = current?.id === id ? current : jobs.find((j) => j.id === id);
    if (!job) return;
    job.result = isError;
    job.h?.done(!isError);
  };

  function onAgent(e) {
    const a = getAgent();
    if (!a) return;
    switch (e.type) {
      case 'start':
        heard = null;
        if (!listen?.open) thought = a.think('', { stream: true });
        break;
      case 'thinking':
        if (speech || listen?.open) break;
        if (!thought) thought = a.think('', { stream: true, quiet: true });
        thought.append(e.text);
        break;
      case 'text': {
        if (listen?.open) break;
        let text = e.text;
        if (!speech) {
          // A fresh bubble never starts with the space that joins a follow-up turn.
          text = text.replace(/^\s+/, '');
          if (!text) break;
          // say() morphs an open thought cloud into the speech bubble, so drop the thought handle.
          thought = null;
          speech = a.say('', { stream: true, mood: nextMood });
          nextMood = null;
        }
        speech.append(text);
        break;
      }
      case 'tool':
        if (listen?.open) break;
        // Tools with nothing to show (listing commitments) don't interrupt the bubble.
        if (!e.anim) break;
        endTalk();
        jobs.push({ id: e.id, anim: e.anim }); playTools();
        break;
      case 'tool_end':
        settle(e.id, e.isError);
        break;
      case 'point': {
        // Teach mode: control bounds arrive in global screen points → this overlay's coordinates.
        endTalk();
        const o = Roamie.origin ?? { x: 0, y: 0 }, [x, y, w, h] = e.rect;
        a.point({ rect: [x - o.x, y - o.y, w, h], say: e.say, step: e.step, of: e.of, label: e.label })
          .then(() => send({ type: 'point_shown', id: e.id }));
        break;
      }
      case 'tool_target': {
        // The real window being captured, in global screen points → this overlay's coordinates.
        const job = current?.id === e.id ? current : jobs.find((j) => j.id === e.id);
        if (!job || !e.window?.bounds) break;
        const [x, y, w, h] = e.window.bounds, o = Roamie.origin ?? { x: 0, y: 0 };
        const rect = [x - o.x, y - o.y, x - o.x + w, y - o.y + h];
        job.target = rect; job.targetName = e.window.app;
        job.h?.target(rect, e.window.app);
        break;
      }
      case 'emote':
        nextMood = MOODS[e.action] ?? null;
        a.act(e.action);
        break;
      case 'done':
        endTalk();
        // A stopped turn ends with 'done' but no tool_end for the tool it cut off: stop its spinner.
        for (const j of [current, ...jobs]) if (j && j.result === undefined) settle(j.id, true);
        setTimeout(() => a.endGuide?.(), 6000);
        break;
      case 'error':
        endTalk();
        for (const j of [current, ...jobs]) if (j && j.result === undefined) settle(j.id, true);
        a.say(e.message, { mood: 'concerned' });
        break;
    }
  }

  // ---------- voice (⌃⌥) ----------
  let streaming = true;
  function onVoice(m) {
    const a = getAgent();
    if (!a) return;
    if (m.type === 'state' && m.state === 'listening') {
      if (ask) finishAsk(null);
      endTalk();
      heard = null;
      // Engines that don't stream (Parakeet) send no partials, so say the text comes at the end.
      streaming = m.streaming !== false;
      const placeholder = streaming
        ? (m.mode === 'handsfree' ? 'Listening… tap again to send' : 'Listening…')
        : (m.mode === 'handsfree' ? "Listening… I'll write it out when you tap again" : "Listening… I'll write it out when you stop");
      listen = a.listen({ placeholder });
    } else if (m.type === 'partial') { if (streaming) listen?.set(m.text); }
    else if (m.type === 'level') listen?.level(m.v);
    else if (m.type === 'state' && m.state === 'processing') { if (!streaming) listen?.hint('Writing it out…'); listen?.processing(); }
    else if (m.type === 'final') {
      // Keep what was heard on screen until the agent starts thinking.
      if (listen) { listen.set(m.text).processing(); heard = listen; listen = null; Roamie.sfx?.play('heard'); }
    } else if (m.type === 'dictated') {
      // Dictation: no agent hand-off, so close the transcript once it's pasted.
      if (heard) { const h = heard; setTimeout(() => { if (heard === h) { h.close(); heard = null; } }, 600); }
    } else if (m.type === 'state' && m.state === 'idle') {
      listen?.close(); listen = null;
      if (heard) { const h = heard; setTimeout(() => { if (heard === h) { h.close(); heard = null; } }, 4000); }
    }
  }

  window.__roamieHost = (m) => {
    if (m.kind === 'sound') { if (Roamie.sfx) Roamie.sfx.enabled = m.on; return; }
    if (!getAgent()) return;
    if (m.kind === 'greet') { getAgent().act('wave'); return; }
    if (m.kind === 'intro') { getAgent().intro(m.x, m.text); return; }
    if (m.kind === 'summon') {
      // ⌃⌥S toggles; the menu's Show Sidekick only ever shows.
      const a = getAgent();
      if (m.show || !a.visible) { if (a.show({ summoned: true })) a.act('wave'); }
      else a.hide();
      return;
    }
    if (m.kind === 'say') { if (!ask) getAgent().say(m.text, { mood: m.mood ?? null }); }
    else if (m.kind === 'ask') openAsk(m);
    else if (m.kind === 'cancel_ask') { if (ask?.id === m.id) { ask.id = null; finishAsk(null); } }
    else if (m.kind === 'agent') onAgent(m.e);
    else if (m.kind === 'voice') onVoice(m);
    else if (m.kind === 'progress') onProgress(m);
    else if (m.kind === 'list') getAgent().list(m);
  };

  // Long-running status (the Windows voice model download): one bubble per id, updated in place.
  const progress = new Map();
  function onProgress(m) {
    const cur = progress.get(m.id);
    if (m.done) { cur?.close(); progress.delete(m.id); return; }
    if (ask) return;
    if (cur?.open) cur.set(m.text);
    // Don't talk over another bubble; the next update reopens it once the Sidekick is free.
    else if (!getAgent().busy) progress.set(m.id, getAgent().status(m.text));
  }

  // Start hidden in auto mode and tell the brain we're listening. It replies with the sound setting,
  // and a greeting wave unless the setup guide is about to open.
  const ready = () => {
    const a = getAgent();
    if (!a) return setTimeout(ready, 150);
    a.setAuto(true);
    a.onListToggle = (id) => send({ type: 'list_toggle', id });
    a.hide({ instant: true });
    send({ type: 'ui_ready' });
  };
  ready();
})();
