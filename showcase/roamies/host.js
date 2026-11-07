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
  if (window.Roamie) Roamie.onContext = () => invoke('show_settings').catch(() => {});
  // macOS: the voice helper can draw the cursor-form sidekick while it just follows the cursor (agent.js nativeStep,
  // voice/buddy.swift). Not available (Windows, helper not running): the page keeps drawing it.
  let buddyOff = /Mac/.test(navigator.platform) ? 0 : Infinity;
  const buddyGone = (ms) => { buddyOff = performance.now() + ms; Roamie.buddy.onEvent?.({ state: 'gone' }); };
  Roamie.buddy = {
    onEvent: null,
    available: () => performance.now() > buddyOff,
    show: (msg) => invoke('buddy', { msg: { ...msg, on: true } }).then((ok) => { if (!ok) buddyGone(10000); }, () => buddyGone(60000)),
    hide: () => invoke('buddy', { msg: { on: false } }).catch(() => {}),
  };
  window.__roamieBuddy = (m) => { Roamie.wake?.(); Roamie.buddy.onEvent?.(m); };
  let hot = null, cursor = null;
  window.__roamiePtr = (x, y, t) => {
    if (!window.Roamie?.ptr) return;
    cursor = [x, y];
    const h = Roamie.ptr(x, y, t);
    if (h !== hot) { hot = h; invoke('set_hot', { hot: h }).catch(() => { hot = null; }); }
  };

  let agent = null;
  const getAgent = () => (agent ??= Roamie.tiles?.find((t) => t.creature?.agent)?.creature.agent ?? null);

  // ---------- typing into an input bubble ----------
  // A real (invisible) input collects keys, so paste, IME and key repeat all just work.
  const field = document.createElement('input');
  Object.assign(field.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  // Its name is its look's (the sidecar's LOOKS).
  const NAMES = { classic: 'Roamie', jarvis: 'JARVIS', anime: 'Anime Girl', sarah: 'Sarah', adrian: 'Adrian' };
  field.setAttribute('aria-label', 'Message for Roamie');
  field.autocomplete = 'off'; field.spellcheck = false;
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(field));
  if (document.body) document.body.appendChild(field);

  let ask = null;
  const focusField = () => { typing(true); setTimeout(() => field.focus(), 30); ask?.h.focus(true); };
  const finishAsk = (text) => {
    if (!ask) return;
    const { id, h, request } = ask;
    ask = null;
    field.blur(); field.value = '';
    typing(false);
    h.close();
    // Only a new typed request gets a request id from the host; yes/no and key answers belong to a running one.
    if (id) send({ type: 'answer', id, text, ...(request ? { request: true } : {}) });
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
    ask = { id: m.id, h, request: !!m.request };
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
  let speech = null, thought = null, nextMood = null, listen = null, heard = null, responding = false;
  // waveTurn: a spoken question whose "thinking" shows as dots beside the cursor (macOS), so the Sidekick
  // shows no thought cloud of its own. research: this turn reads the web, so its answer goes on the card.
  let waveTurn = false, research = false, heardText = false, spoken = '', fromWeb = false;
  // An answer that turns into points (or cites sources) reads better on the card than in a bubble.
  const LISTY = /\n\s*(?:[-*•]|\d+[.)])\s+\S|\n\s*sources?\s*:/i;
  const panel = () => {
    const p = Roamie.panel;
    if (p && !p.onLink) p.onLink = (url) => send({ type: 'open_link', url });
    return p;
  };
  // The card opens just past the cursor and the Sidekick beside it.
  const near = () => (cursor ? { cursor, buddy: getAgent()?.pos } : null);
  const webStatus = (anim) => (anim.variant === 'fetch' && anim.detail ? `Reading ${anim.detail}` : 'Searching the web');
  const jobs = [];
  let current = null;
  // Telemetry (roamies/telemetry.js): agent start → first text on screen, per request id.
  const tel = window.RoamiesTelemetry;
  let firstBubble = null;
  // ui.reply_paint: the reply reaching the page → its bubble painted (double rAF ≈ the next frame on screen).
  let replyRid = null;
  const paintMark = (requestId, outcome = 'ok', errorCode = null) => {
    const p = globalThis.performance;
    if (!tel?.measure || !p?.mark) return;
    const key = `${requestId ?? 'none'}:${p.now()}`, recv = `reply-recv:${key}`, painted = `reply-painted:${key}`;
    p.mark(recv);
    return () => requestAnimationFrame(() => requestAnimationFrame(() => {
      p.mark(painted);
      tel.measure('ui.reply_paint', recv, painted, { requestId, outcome, errorCode });
    }));
  };
  const endFirstBubble = (outcome) => { if (firstBubble) { tel?.end(firstBubble, { outcome }); firstBubble = null; } };
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
      job.h = a.tool(job.anim.tool, { variant: job.anim.variant, label: job.anim.label, detail: job.anim.detail, live: true, rect: job.target, rectName: job.targetName });
      if (job.image) job.h.state.image = job.image;
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
        endFirstBubble('cancelled');
        firstBubble = tel?.start('ui.first_bubble', { requestId: e.request_id }) ?? null;
        replyRid = e.request_id ?? null;
        responding = true;
        heard = null;
        research = false; fromWeb = false; spoken = '';
        if (!listen?.open && !waveTurn) thought = a.think('', { stream: true });
        break;
      case 'thinking':
        if (speech || listen?.open || waveTurn || research) break;
        if (!thought) thought = a.think('', { stream: true, quiet: true });
        thought.append(e.text);
        break;
      case 'text': {
        if (listen?.open) break;
        if (research) {
          if (research === 'looking') { research = 'writing'; panel()?.status('Writing it up'); }
          panel()?.append(e.text);
          break;
        }
        if (speech && LISTY.test(spoken + e.text)) {
          // Move what's been said so far onto the card and carry on there.
          const so = (spoken + e.text).replace(/^\s+/, '');
          speech.end(); a.hush(); speech = null; spoken = '';
          research = 'writing';
          panel()?.open({ status: 'Writing it up', near: near() }).append(so);
          break;
        }
        let text = e.text;
        if (!speech) {
          // A fresh bubble never starts with the space that joins a follow-up turn.
          text = text.replace(/^\s+/, '');
          if (!text) break;
          // say() morphs an open thought cloud into the speech bubble, so drop the thought handle.
          thought = null;
          const painted = paintMark(replyRid);
          speech = a.say('', { stream: true, mood: nextMood });
          nextMood = null;
          endFirstBubble('ok');
          speech.append(text);
          painted?.();
          break;
        }
        speech.append(text);
        spoken += text;
        break;
      }
      case 'tool':
        if (listen?.open) break;
        // Tools with nothing to show (listing commitments) don't interrupt the bubble.
        if (!e.anim) break;
        endTalk();
        // The web: the answer will stream onto the card (opened now, saying what it's looking up).
        // The card says what it's looking up, so the web prop and chip don't play (they'd sit under the card).
        if (e.anim.tool === 'web') {
          fromWeb = true;
          if (!research) { research = 'looking'; a.show(); panel()?.open({ status: webStatus(e.anim), near: near() }); }
          else { research = 'looking'; panel()?.status(webStatus(e.anim)); }
          break;
        }
        jobs.push({ id: e.id, anim: e.anim }); playTools();
        break;
      case 'tool_end':
        settle(e.id, e.isError);
        break;
      case 'point': {
        // Teach mode: control bounds arrive in global screen points → this overlay's coordinates.
        endTalk();
        // local: the host already converted it (Windows, physical pixels per monitor).
        const o = (!e.local && Roamie.origin) || { x: 0, y: 0 }, [x, y, w, h] = e.rect;
        a.point({ rect: [x - o.x, y - o.y, w, h], say: e.say, step: e.step, of: e.of, label: e.label })
          .then(() => send({ type: 'point_shown', id: e.id }));
        break;
      }
      case 'tool_target': {
        // The real window being captured, in global screen points → this overlay's coordinates.
        const job = current?.id === e.id ? current : jobs.find((j) => j.id === e.id);
        if (!job || !e.window?.bounds) break;
        const [x, y, w, h] = e.window.bounds, o = (!e.local && Roamie.origin) || { x: 0, y: 0 };
        const rect = [x - o.x, y - o.y, x - o.x + w, y - o.y + h];
        job.target = rect; job.targetName = e.window.app;
        job.h?.target(rect, e.window.app);
        break;
      }
      case 'tool_image': {
        // The shot it actually took: the screenshot prints it into its frame and onto the photo it carries back.
        const job = current?.id === e.id ? current : jobs.find((j) => j.id === e.id);
        if (!job || !e.src) break;
        const img = new Image();
        img.onload = () => { job.image = img; if (job.h?.state) job.h.state.image = img; };
        img.src = e.src;
        break;
      }
      // The parts of a "do this, then that" request, ticking off.
      case 'trail': a.cards?.trail(e); break;
      case 'emote':
        nextMood = MOODS[e.action] ?? null;
        a.act(e.action);
        break;
      case 'done':
        endFirstBubble('cancelled'); // finished without showing any text
        responding = false;
        if (research) panel()?.end(fromWeb ? 'From the web' : 'Answer');
        research = waveTurn = false;
        endTalk();
        // A stopped turn ends with 'done' but no tool_end for the tool it cut off: stop its spinner.
        for (const j of [current, ...jobs]) if (j && j.result === undefined) settle(j.id, true);
        setTimeout(() => a.endGuide?.(), 6000);
        break;
      case 'error':
        endFirstBubble('error');
        responding = false;
        if (research) panel()?.fail(e.message);
        research = waveTurn = false;
        endTalk();
        for (const j of [current, ...jobs]) if (j && j.result === undefined) settle(j.id, true);
        const painted = paintMark(e.request_id ?? replyRid, 'error', 'agent_error');
        a.say(e.message, { mood: 'concerned' });
        painted?.();
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
      panel()?.close();
      // macOS: the listening shows as voice bars beside the cursor, so the sidekick steps away until it answers.
      if (m.wave) {
        waveTurn = true;
        thought?.end(); thought = null;
        a.endGuide?.();
        if (a.visible) a.hide();
        Roamie.sfx?.play('listen');
        return;
      }
      // Engines that don't stream (Parakeet) send no partials, so say the text comes at the end.
      streaming = m.streaming !== false;
      const placeholder = streaming
        ? (m.mode === 'handsfree' ? 'Listening… tap again to send' : 'Listening…')
        : (m.mode === 'handsfree' ? "Listening… I'll write it out when you tap again" : "Listening… I'll write it out when you stop");
      listen = a.listen({ placeholder });
      tel?.record('ui.listen_shown', { requestId: m.request_id, attrs: { mode: m.mode ?? 'hold' } });
    } else if (m.type === 'partial') { if (streaming) listen?.set(m.text); }
    else if (m.type === 'level') listen?.level(m.v);
    else if (m.type === 'state' && m.state === 'processing') { if (!streaming) listen?.hint('Writing it out…'); listen?.processing(); }
    else if (m.type === 'final') {
      heardText = true;
      // Keep what was heard on screen until the agent starts thinking.
      if (listen) { listen.set(m.text).processing(); heard = listen; listen = null; }
      Roamie.sfx?.play('heard');
    } else if (m.type === 'dictated') {
      // Dictation: no agent hand-off, so close the transcript once it's pasted.
      if (heard) { const h = heard; setTimeout(() => { if (heard === h) { h.close(); heard = null; } }, 600); }
    } else if (m.type === 'state' && m.state === 'idle') {
      // Nothing was heard (or it was cancelled): no answer is coming for that talk.
      if (m.cancelled || !heardText) waveTurn = false;
      heardText = false;
      listen?.close(); listen = null;
      if (heard) { const h = heard; setTimeout(() => { if (heard === h) { h.close(); heard = null; } }, 4000); }
    }
  }

  // One Sidekick shows at a time. Overlays on other monitors (guests) hold a hidden copy that takes
  // over when the host moves it there to point at something.
  let active = !window.ROAMIE_GUEST;
  function setActive(on) {
    active = !!on;
    const a = getAgent();
    if (active || !a) return;
    if (ask) finishAsk(null);
    endTalk();
    listen?.close(); listen = null; heard?.close(); heard = null;
    for (const j of [current, ...jobs]) if (j && j.result === undefined) settle(j.id, true);
    a.endGuide?.();
    a.hide();
  }

  window.__roamieHost = (m) => {
    Roamie.wake?.(); // the frame loop naps while the sidekick is hidden
    if (m.kind === 'speech') { Roamie.voiceOut?.handle(m); return; } // plays on, even while it changes screens
    if (m.kind === 'sound') { if (Roamie.sfx) Roamie.sfx.enabled = m.on; return; }
    if (m.kind === 'telemetry') { tel?.setEnabled(m.on); return; }
    if (m.kind === 'active') { setActive(m.on); return; }
    if (m.kind === 'size') { for (const t of Roamie.tiles ?? []) t.creature.setForm?.(m.size); return; }
    if (m.kind === 'look') {
      for (const t of Roamie.tiles ?? []) t.creature.setLook?.(m.look);
      field.setAttribute('aria-label', `Message for ${NAMES[m.look] ?? NAMES.classic}`);
      return;
    }
    if (!active || !getAgent()) return;
    if (m.kind === 'greet') { getAgent().act('wave'); return; }
    if (m.kind === 'intro') { getAgent().intro(m.x, m.text); return; }
    if (m.kind === 'esc') { onEsc(); return; }
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

  // ---------- Esc ----------
  // While it's on screen, Esc stops an answer (and the voice), or sends it away when it's idle. The shell holds a
  // global Esc only meanwhile (other apps don't get Esc while it does), so this overlay says when it's up.
  const up = () => !!(getAgent()?.visible || ask || Roamie.panel?.isOpen);
  function onEsc() {
    const a = getAgent();
    if (!a || !up()) return;
    if (ask) { finishAsk(null); return; }
    if (responding || Roamie.voiceOut?.playing()) { send({ type: 'menu', id: 'stop' }); Roamie.voiceOut?.stop(); return; }
    if (Roamie.panel?.isOpen) Roamie.panel.close();
    endTalk(); listen?.close(); listen = null;
    if (a.visible) a.hide();
  }
  let escUp = null;
  setInterval(() => {
    const on = up();
    if (on !== escUp) { escUp = on; invoke('esc_watch', { on }).catch(() => { escUp = null; }); }
  }, 150);

  // Start hidden in auto mode and tell the brain we're listening. It replies with the sound setting,
  // and a greeting wave unless the setup guide is about to open.
  const ready = () => {
    const a = getAgent();
    if (!a) return setTimeout(ready, 150);
    a.setAuto(true);
    a.onListToggle = (id) => send({ type: 'list_toggle', id });
    a.hide({ instant: true });
    if (!window.ROAMIE_GUEST) return send({ type: 'ui_ready' });
    send({ type: 'ui_ready', guest: true });
    // Built on demand for a point on this monitor: the first messages came with the page.
    for (const m of window.ROAMIE_PENDING ?? []) window.__roamieHost(m);
  };
  ready();
})();
