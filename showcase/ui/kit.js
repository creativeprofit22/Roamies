// Roamies UI kit: DOM, keycap and download-meter helpers shared by the setup guide and Settings.
// Classic script (like roamies/*.js); pairs with ui/kit.css. Keycap helpers take an isMac getter so each page
// keeps its own platform source.
(() => {
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids.filter((k) => k != null)); return n; };
  const led = (mode = 'on') => el('i', { className: `led ${mode}`, ariaHidden: 'true' });
  const okMark = (label) => el('span', { className: 'status' }, led(), label);

  // Keycaps for shortcuts: Apple's symbols and order on a Mac, the key names on Windows and Linux.
  const MAC_MOD = { control: '⌃', option: '⌥', shift: '⇧', command: '⌘' };
  const PC_MOD = { control: 'Ctrl', option: 'Alt', shift: 'Shift', command: 'Win' };
  const ORDER = ['control', 'option', 'shift', 'command'];
  const ACC_MOD = { Control: 'control', Alt: 'option', Shift: 'shift', Command: 'command' };
  const keyLabel = (code) => code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '') .replace('Backquote', '`').replace('Minus', '-').replace('Equal', '=').replace('BracketLeft', '[').replace('BracketRight', ']').replace('Backslash', '\\').replace('Semicolon', ';').replace('Quote', "'").replace('Comma', ',').replace('Period', '.').replace('Slash', '/');
  const capsFor = (mods, key, isMac) => [...[...mods].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).map((x) => (isMac() ? MAC_MOD : PC_MOD)[x]), ...(key ? [keyLabel(key)] : [])];
  const accelCaps = (accel, isMac) => { const parts = accel.split('+'); return capsFor(parts.slice(0, -1).map((p) => ACC_MOD[p]), parts.at(-1), isMac); };
  const capsEl = (caps) => { const s = el('span', { className: 'caps' }); for (const c of caps) s.append(el('kbd', { className: 'px cap', textContent: c })); return s; };
  const fillCaps = (node, caps) => { node.replaceChildren(...caps.map((c) => el('kbd', { className: 'px cap', textContent: c }))); };

  // Download meter: ten LED segments like the step bar. The percentage is for sighted users; screen
  // readers get the progressbar value, so the live list isn't re-announced on every tick.
  const pctOf = (vm) => Math.min(100, Math.floor((vm.done / (vm.total || 1)) * 100));
  function fillMeter(meter, vm) {
    const pct = pctOf(vm);
    [...meter.children].forEach((seg, i) => seg.classList.toggle('on', i < Math.round(pct / 10)));
    meter.setAttribute('aria-valuenow', String(pct));
    meter.nextElementSibling.textContent = `${pct}%`;
  }
  function dlMeter(vm, label = 'Voice download') {
    const meter = el('span', { className: 'dl', role: 'progressbar' }, ...Array.from({ length: 10 }, () => el('i')));
    meter.setAttribute('aria-label', label);
    meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', '100');
    const wrap = el('span', { className: 'dl-wrap' }, meter, el('span', { className: 'waiting dl-pct', ariaHidden: 'true' }));
    fillMeter(meter, vm);
    return wrap;
  }

  window.RoamiesKit = { el, led, okMark, PC_MOD, keyLabel, capsFor, accelCaps, capsEl, fillCaps, dlMeter, fillMeter, pctOf };
})();
