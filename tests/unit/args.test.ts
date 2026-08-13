import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flagBool, flagList, flagNumber, flagString, parseArgs } from '../../src/cli/args.js';
import { UsageError } from '../../src/util/errors.js';

describe('parseArgs', () => {
  it('separates the command from positionals', () => {
    const args = parseArgs(['show', 'job_abc', '--full']);
    assert.equal(args.command, 'show');
    assert.deepEqual(args.positionals, ['job_abc']);
    assert.equal(flagBool(args, 'full'), true);
  });

  it('supports --flag=value and --flag value', () => {
    const args = parseArgs(['scan', '--source=greenhouse', '--limit', '10']);
    assert.equal(flagString(args, 'source'), 'greenhouse');
    assert.equal(flagNumber(args, 'limit'), 10);
  });

  it('supports --no-flag', () => {
    const args = parseArgs(['scan', '--no-color']);
    assert.equal(flagBool(args, 'color', true), false);
  });

  it('parses comma separated lists', () => {
    const args = parseArgs(['scan', '--source', 'a,b , c']);
    assert.deepEqual(flagList(args, 'source'), ['a', 'b', 'c']);
  });

  it('rejects non-numeric numbers', () => {
    const args = parseArgs(['list', '--limit', 'many']);
    assert.throws(() => flagNumber(args, 'limit'), UsageError);
  });

  it('treats everything after -- as positional', () => {
    const args = parseArgs(['ask', '--', '--not-a-flag']);
    assert.deepEqual(args.positionals, ['--not-a-flag']);
  });
});
