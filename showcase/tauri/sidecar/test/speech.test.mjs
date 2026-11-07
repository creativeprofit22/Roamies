import assert from 'node:assert/strict';
import { SpeechText, speakable, CueFilter, VOICE_CUES, CUE_INTENSITY } from '../speech.mjs';

const said = (chunks, flushAt = []) => {
  const out = [];
  const s = new SpeechText((t) => out.push(t));
  chunks.forEach((c, i) => { s.push(c); if (flushAt.includes(i)) s.flush(); });
  s.flush();
  return out;
};

// Sentences go out as soon as they end, even when the stream splits them oddly.
assert.deepEqual(said(['It', "'s 36. That's", ' 15 percent of 240. Want', ' the tip too?']), ["It's 36.", "That's 15 percent of 240.", 'Want the tip too?']);
// A preamble before a tool call is spoken right away (flushed at the tool call), without waiting for more text.
assert.deepEqual(said(['On it, checking the weather in Paris'], [0]), ['On it, checking the weather in Paris']);
// Cards: the one-sentence answer is said; the points and sources are only shown.
assert.deepEqual(said(['Paris will be sunny, around 18 degrees.\n- Morning: 12°C, clear\n- Afternoon: 18°C\n', 'Sources: [BBC](https://bbc.co.uk) [Met](https://x.y)']), ['Paris will be sunny, around 18 degrees.']);
// Drafts quoted with "> ", numbered steps, code blocks, tables and headings stay on screen.
assert.deepEqual(said(["Here's a draft for your landlord.\n> Hi Sam, the rent will be a few days late.\n> Thanks, Ken\nShall I send it?"]), ["Here's a draft for your landlord.", 'Shall I send it?']);
assert.deepEqual(said(['Two steps.\n1. Open Settings\n2. Click Wi-Fi\nThen try again.']), ['Two steps.', 'Then try again.']);
assert.deepEqual(said(['Run this:\n```\nnpm install\nnpm test\n```\nThat should fix it.']), ['Run this:', 'That should fix it.']);
assert.deepEqual(said(['## Title\n| a | b |\n|---|---|\nDone.']), ['Done.']);
// A list marker split across chunks is still recognised.
assert.deepEqual(said(['Ok.\n', '-', ' item one\n', 'Bye.']), ['Ok.', 'Bye.']);
assert.deepEqual(said(['Ok.\n1', '0. tenth step\nBye.']), ['Ok.', 'Bye.']);
// Decimals and versions don't end a sentence.
assert.deepEqual(said(['Version 3.5 is out. It costs $4.99 now.']), ['Version 3.5 is out.', 'It costs $4.99 now.']);
// Run-on text is spoken in pieces instead of waiting for the end.
const long = said([`${'word '.repeat(30)}, ${'more '.repeat(30)}`]);
assert.ok(long.length >= 2 && long.every((s) => s.length <= 230), JSON.stringify(long));

// Cleaning: no markdown, links, URLs, paths, emoji or long code; short code words stay; brackets lose their brackets.
assert.equal(speakable('**36** is the answer 🎉'), '36 is the answer');
assert.equal(speakable('See [the docs](https://fish.audio/docs) or https://example.com/a?b=1.'), 'See the docs or.');
assert.equal(speakable('Open `~/Downloads/report.pdf` now'), 'Open now');
assert.equal(speakable('Run `npm` first'), 'Run npm first');
assert.equal(speakable('Saved to /Users/ken/Documents/notes.txt.'), 'Saved to.');
assert.equal(speakable('Hi [landlord name], thanks'), 'Hi landlord name, thanks');
assert.equal(speakable('Hi [Landlord]'), 'Hi Landlord', 'not a cue: brackets go');
assert.equal(speakable('✅ 🎬'), '');
assert.equal(speakable('*waves* hello'), 'waves hello');
// Blank lines between the spoken answer and the points (the usual card shape), streamed or all at once.
const card = "Paris looks gray, around 11 degrees. Bring an umbrella.\n\n- Calm, overcast weather.\n- No storm alerts.\n\nSources: [Sortir](https://x.y/a)";
assert.deepEqual(said([card]), ['Paris looks gray, around 11 degrees.', 'Bring an umbrella.']);
assert.deepEqual(said([...card]), ['Paris looks gray, around 11 degrees.', 'Bring an umbrella.'], 'one character at a time');
assert.deepEqual(said(['Draft below.\n\n> Hi,\n>\n> rent is late.\n\nWant changes?']), ['Draft below.', 'Want changes?']);
// Voice cues are kept for Fish (lower-cased); unknown brackets are unwrapped; a cue alone says nothing.
assert.equal(speakable('[Chuckling] Ha, nice one.'), '[chuckling] Ha, nice one.');
assert.equal(speakable('[slightly sad] Oh no. [break] Let me fix it.'), '[slightly sad] Oh no. [break] Let me fix it.');
assert.equal(speakable('[dry, amused] Sure.'), '[dry, amused] Sure.');
assert.equal(speakable('[warm and curious] Tell me more.'), '[warm and curious] Tell me more.');
assert.equal(speakable('[laughing]'), '');
assert.deepEqual(said(['[excited] We did it! ', '[break] Now rest.']), ['[excited] We did it!', '[break] Now rest.']);
// The body's emote sets the tone of the next sentence only, unless the sentence brings its own cue.
{
  const out = [], s = new SpeechText((t) => out.push(t));
  s.emote('hype'); s.push('You shipped it! Proud of you. '); s.emote('wave'); s.push('[calm] Bye now.'); s.flush();
  assert.deepEqual(out, ['[excited] You shipped it!', 'Proud of you.', '[calm] Bye now.']);
}
// On screen: cues are removed even when split across chunks; other brackets and links are untouched.
{
  const f = new CueFilter();
  const shown = ['[chuck', 'ling] Ha, nice, [landlord] ok ', '[break]', 'done [docs](https://x.y) [slightly ', 'sad] Oh.', ' [unfinished'].map((c) => f.push(c)).join('') + f.flush();
  assert.equal(shown, 'Ha, nice, [landlord] ok done [docs](https://x.y) Oh. [unfinished');
  assert.equal(new CueFilter().push('Array[0] and [x]'), 'Array[0] and [x]');
  // No stray spaces where a cue was, whatever the chunking.
  const run = (chunks) => { const g = new CueFilter(); return chunks.map((c) => g.push(c)).join('') + g.flush(); };
  assert.equal(run(['[empathetic]', ' Oh, sorry.', ' [break]', ' Losing a dog hurts.']), 'Oh, sorry. Losing a dog hurts.');
  assert.equal(run(['bugs. [chuckling] Your names']), 'bugs. Your names');
  assert.equal(run(['bugs. ', '[chuck', 'ling]', ' Your names']), 'bugs. Your names');
  assert.equal(run(['Hi', ' there']), 'Hi there', 'ordinary spaces between chunks stay');
}
// Every Fish cue is kept for the voice and hidden on screen, in any case, with or without an intensity.
{
  const all = Object.values(VOICE_CUES).flat();
  assert.ok(all.length >= 90, `all of Fish's cues (${all.length})`);
  for (const c of all) {
    assert.equal(speakable(`[${c.toUpperCase()}] Hi.`), `[${c}] Hi.`, c);
    assert.equal(new CueFilter().push(`Ok. [${c}] Hi.`), 'Ok. Hi.', c);
  }
  for (const i of CUE_INTENSITY) assert.equal(speakable(`[${i} sad] Oh.`), `[${i} sad] Oh.`, i);
  assert.equal(speakable('[sad][whispering] I miss you.'), '[sad][whispering] I miss you.', 'stacked');
  assert.equal(speakable('[very shouting] Hi.'), '[very shouting] Hi.', 'intensity on a tone');
}
// Free descriptions S2 understands: a cue at a sentence start, text anywhere else.
assert.equal(speakable('[caring] Your thesis can wait.'), '[caring] Your thesis can wait.');
assert.equal(speakable('Long day. [quietly proud] You did it.'), 'Long day. [quietly proud] You did it.');
assert.equal(speakable('Hi [landlord name], the rent is late.'), 'Hi landlord name, the rent is late.');
assert.equal(speakable('[Landlord Name] is fine.'), 'Landlord Name is fine.');
{
  const run = (chunks) => { const g = new CueFilter(); return chunks.map((c) => g.push(c)).join('') + g.flush(); };
  assert.equal(run(["It's past midnight. [caring] Your thesis can wait."]), "It's past midnight. Your thesis can wait.");
  assert.equal(run(["It's past midnight. ", '[car', 'ing] Your thesis can wait.']), "It's past midnight. Your thesis can wait.");
  assert.equal(run(['[soothing] Breathe.']), 'Breathe.');
  assert.equal(run(['Read more. [docs](https://x.y)']), 'Read more. [docs](https://x.y)', 'links stay');
  assert.equal(run(['Read more. [docs]', '(https://x.y) ok']), 'Read more. [docs](https://x.y) ok', 'links split across chunks stay');
  assert.equal(run(['Hi [landlord name], rent is late.\n> Thanks,\n> [your name]']), 'Hi [landlord name], rent is late.\n> Thanks,\n> [your name]');
}
console.log('speech text tests: passed');
{ // Plain-words delivery cues (Drama 3 performs them) are spoken but never shown.
  const f = new CueFilter();
  assert.equal(f.push('[quietly, a little embarrassed] Oops, I missed that. ') + f.push('[bright and bouncy] You did it!'), 'Oops, I missed that. You did it!');
  assert.equal(speakable('[bright and bouncy] You did it!'), '[bright and bouncy] You did it!');
}
