// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { addCustomStackTag, getCustomStackTags } from '../lib/custom-stack-tags.js';
import { db } from '../lib/db.js';

describe('custom stack tags', () => {
  beforeEach(async () => {
    await db.meta.clear();
  });

  it('starts empty', async () => {
    expect(await getCustomStackTags()).toEqual([]);
  });

  it('persists an added tag across reads', async () => {
    await addCustomStackTag('Elixir');
    expect(await getCustomStackTags()).toEqual(['Elixir']);
  });

  it('accumulates multiple tags in the order added', async () => {
    await addCustomStackTag('Elixir');
    await addCustomStackTag('Phoenix');
    expect(await getCustomStackTags()).toEqual(['Elixir', 'Phoenix']);
  });

  it('does not add a duplicate, case-insensitively', async () => {
    await addCustomStackTag('Elixir');
    await addCustomStackTag('elixir');
    expect(await getCustomStackTags()).toEqual(['Elixir']);
  });

  it('does not add an empty or whitespace-only tag', async () => {
    await addCustomStackTag('   ');
    expect(await getCustomStackTags()).toEqual([]);
  });

  it('trims a tag before storing it', async () => {
    await addCustomStackTag('  Elixir  ');
    expect(await getCustomStackTags()).toEqual(['Elixir']);
  });
});
