// Windows app lookup by Start-menu name: matching, parsing, "did you mean", session cache. Run: npm test
import assert from 'node:assert/strict';
import { closest, createAppFinder, launchTarget, matchApp, parseApps } from '../winapps.mjs';

const APPS = [
  { name: 'Spotify', appId: 'C:\\Users\\ken\\AppData\\Roaming\\Spotify\\Spotify.exe' },
  { name: 'Google Chrome', appId: 'Chrome' },
  { name: 'Microsoft Edge', appId: 'MSEdge' },
  { name: 'WordPad', appId: '{6D809377}\\Windows NT\\Accessories\\wordpad.exe' },
  { name: 'Word 2016', appId: '{6D809377}\\Microsoft Office\\Office16\\WINWORD.EXE' },
  { name: 'Calculadora', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
  { name: 'Configuración', appId: 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel' },
  { name: 'Configuración del sistema', appId: '{1AC14E77}\\msconfig.exe' },
  { name: 'WhatsApp', appId: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' },
  { name: 'Microsoft Store', appId: 'Microsoft.WindowsStore_8wekyb3d8bbwe!App' },
  { name: 'Windows Hardware Accessory Test Suite Application Pack', appId: 'Whatever.Tool' },
];
const id = (q, apps = APPS) => matchApp(q, apps)?.app.appId ?? null;

assert.equal(id('spotify'), APPS[0].appId, 'exact, any case');
assert.equal(id('chrome'), 'Chrome', 'chrome → Google Chrome');
assert.equal(id('Google Chrome'), 'Chrome', 'full name');
assert.equal(id('gc'), 'Chrome', 'word-start initials');
assert.equal(id('vscode', [...APPS, { name: 'Visual Studio Code', appId: 'VSCode' }]), 'VSCode', 'word-start pieces');
assert.equal(id('word'), APPS[4].appId, '"word" → Word 2016, not WordPad');
assert.equal(id('word', [...APPS, { name: 'Word', appId: 'Word.Exact' }]), 'Word.Exact', 'exact beats longer names');
assert.equal(id('calculator'), 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', 'English alias on a Spanish list');
assert.equal(id('calculadora'), 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', 'localized name');
assert.equal(id('configuracion'), APPS[6].appId, 'accents ignored; exact beats longer');
assert.equal(id('settings'), 'ms-settings:', 'Settings always opens the Settings app');
assert.equal(id('store'), 'Microsoft.WindowsStore_8wekyb3d8bbwe!App', 'Store alias');
assert.equal(id('xyzzy'), null, 'no match');
assert.equal(id('whatsapp', APPS.filter((a) => a.name !== 'WhatsApp')), null, 'whatsapp does not wander through a long name');
assert.equal(id('calculator', APPS.filter((a) => a.name !== 'Calculadora')), null, 'alias needs the app in the list');
assert.equal(id(''), null, 'empty query');

const near = closest('spotfy', APPS);
assert.ok(near.length <= 3 && near[0] === 'Spotify', `closest: ${near}`);
assert.ok(closest('xyzzy', APPS).length <= 3, 'at most 3');
assert.deepEqual(closest('qqqq', APPS), [], 'nothing similar');

assert.equal(launchTarget({ name: 'Google Chrome', appId: 'Chrome' }), 'shell:AppsFolder\\Chrome');
assert.equal(launchTarget({ name: 'Settings', appId: 'ms-settings:' }), 'ms-settings:');
assert.equal(launchTarget({ name: 'X', appId: 'C:\\ProgramData\\x.lnk', lnk: true }), 'C:\\ProgramData\\x.lnk');

assert.deepEqual(parseApps('{"name":"Calculadora","appId":"Calc!App"}'), [{ name: 'Calculadora', appId: 'Calc!App' }], 'single object');
assert.deepEqual(parseApps('\uFEFF[{"name":" Configuración ","appId":"a"},{"name":"Configuración","appId":"a"},{"name":"","appId":"b"},{"name":"X","appId":"c","lnk":true}]'),
  [{ name: 'Configuración', appId: 'a' }, { name: 'X', appId: 'c', lnk: true }], 'trims, dedupes, keeps accents and .lnk');
assert.deepEqual(parseApps(''), [], 'empty');
assert.deepEqual(parseApps('not json'), [], 'garbage');

let calls = 0;
const lists = [[APPS[0]], [APPS[0], APPS[1]]];
const finder = createAppFinder({ list: async () => lists[Math.min(calls++, 1)] });
assert.equal((await finder.find('spotify')).match.app.name, 'Spotify');
assert.equal((await finder.find('spotify')).match.app.name, 'Spotify');
assert.equal(calls, 1, 'hits use the cache');
assert.equal((await finder.find('chrome')).match.app.name, 'Google Chrome', 'a miss re-lists');
assert.equal(calls, 2, 'one refresh on a miss');
assert.equal((await finder.find('chrome')).match.app.name, 'Google Chrome');
assert.equal(calls, 2, 'refreshed list is cached');
assert.equal((await finder.find('nope')).match, null);
assert.equal(calls, 3, 'each miss refreshes exactly once');
let brokenCalls = 0;
const broken = createAppFinder({ list: async () => { brokenCalls++; throw new Error('no powershell'); } });
const failed = await broken.find('spotify');
assert.equal(failed.match, null);
assert.equal(failed.failed, true, 'a failed list is reported, not a plain miss');
assert.equal(failed.error.message, 'no powershell');
assert.equal(brokenCalls, 1, 'no refresh after a failed first load');
assert.equal((await broken.find('spotify')).failed, true);
assert.equal(brokenCalls, 2, 'a failed list is not cached; the next call retries');
let flakyCalls = 0;
const flaky = createAppFinder({ list: async () => { if (flakyCalls++ === 1) throw new Error('timeout'); return [APPS[0]]; } });
assert.equal((await flaky.find('spotify')).match.app.name, 'Spotify');
const staleMiss = await flaky.find('chrome');
assert.equal(staleMiss.failed, undefined, 'a failed refresh after a good list is still a plain miss');
assert.deepEqual(staleMiss.apps, [APPS[0]], 'keeps the list it already had');
console.log('winapps tests: passed');
