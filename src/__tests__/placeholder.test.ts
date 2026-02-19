import { describe, it, expect } from 'vitest';
import { main } from '../index.js';

describe('placeholder', () => {
  it('main is a function', () => {
    expect(typeof main).toBe('function');
  });
});
