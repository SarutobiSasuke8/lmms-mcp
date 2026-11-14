import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { parseSummary, resolveInLibrary } from './sampler.mjs';

const library = path.resolve('library');

test('resolveInLibrary accepts library-relative files', () => {
  assert.equal(resolveInLibrary(library, 'bass/pizz.sfz'), path.join(library, 'bass', 'pizz.sfz'));
  assert.equal(resolveInLibrary(library, 'MTG Solo Saxophones\\MTG Alto Sax.sfz'), path.join(library, 'MTG Solo Saxophones', 'MTG Alto Sax.sfz'));
});

test('resolveInLibrary rejects escapes', () => {
  assert.throws(() => resolveInLibrary(library, '../outside.sfz'), /without \.\./);
  assert.throws(() => resolveInLibrary(library, 'a/../../b.sfz'), /without \.\./);
  assert.throws(() => resolveInLibrary(library, path.resolve('elsewhere.sfz')), /relative/);
});

test('parseSummary reads the converter line', () => {
  assert.deepEqual(parseSummary('123 samples written, 4 regions skipped, 58 missing files e.g. pizz/noises/x.wav'),
    { samples: 123, skippedRegions: 4, missingFiles: 58, firstMissing: 'pizz/noises/x.wav' });
  assert.deepEqual(parseSummary('7 samples written, 0 regions skipped, 0 missing files'),
    { samples: 7, skippedRegions: 0, missingFiles: 0, firstMissing: undefined });
  assert.throws(() => parseSummary('Traceback'), /Unexpected/);
});
