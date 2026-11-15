import test from 'node:test';
import assert from 'node:assert/strict';
import { laneName, laneFamily, layoutSections, timelineHtml } from './timeline.mjs';

test('lane names and order come from the stem file names', () => {
  assert.deepEqual(laneName('12_Conga Open.wav'), { order: 12, name: 'Conga Open' });
  assert.deepEqual(laneName('1_Kick.wav'), { order: 1, name: 'Kick' });
  assert.deepEqual(laneName('trumpet_solo.wav'), { order: 1e6, name: 'trumpet solo' });
});

test('lanes are grouped into families by role, or by name when no role is known', () => {
  assert.equal(laneFamily('Kick'), 'drums');
  assert.equal(laneFamily('Conga Open'), 'drums');
  assert.equal(laneFamily('Bass'), 'bass');
  assert.equal(laneFamily('Piano'), 'harmony');
  assert.equal(laneFamily('Trumpet Solo'), 'lead');
  assert.equal(laneFamily('Shimmer', 'texture'), 'texture');
  assert.equal(laneFamily('Piano', 'lead'), 'lead');
});

test('sections are filled in, ordered and clipped to the song', () => {
  assert.deepEqual(layoutSections([{ name: 'main', startBar: 4 }, { name: 'intro', startBar: 0 }, { name: 'outro', startBar: 12, bars: 99 }], 16),
    [{ name: 'intro', startBar: 0, bars: 4 }, { name: 'main', startBar: 4, bars: 8 }, { name: 'outro', startBar: 12, bars: 4 }]);
  assert.deepEqual(layoutSections([{ name: 'a', bars: 4 }, { name: 'b', bars: 4 }], 8), [{ name: 'a', startBar: 0, bars: 4 }, { name: 'b', startBar: 4, bars: 4 }]);
  assert.deepEqual(layoutSections([{ name: 'late', startBar: 40 }], 16), []);
  assert.deepEqual(layoutSections(undefined, 8), []);
});

test('the page embeds its data safely and has the transport, lanes and notes', () => {
  const lanes = [{ name: 'Kick </script>', family: 'drums', url: 'stems/1_Kick.wav', peaks: [0, 50, 100] }];
  const html = timelineHtml({ title: 'Song <1>', bpm: 126, bars: 8, seconds: 15.2, lanes, mix: { name: 'Finished mix', family: 'harmony', url: 'song.wav', peaks: [10, 20] },
    sections: [{ name: 'intro', startBar: 0, bars: 4 }], effects: [{ type: 'filter_sweep', startBar: 0, bars: 4, detail: 'filter lowpass' }], generated: '2026-11-15' });
  assert.ok(html.includes('<title>Song &lt;1&gt;</title>'));
  assert.equal(html.split('</script>').length, 3);
  const data = JSON.parse(/<script id="data" type="application\/json">(.*?)<\/script>/s.exec(html)[1]);
  assert.deepEqual(data.lanes, lanes);
  assert.equal(data.effects[0].type, 'filter_sweep');
  for (const id of ['play', 'start', 'clock', 'mode', 'loop', 'unsolo', 'note', 'copy', 'board', 'head', 'notes']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html), 'no network references');
});
