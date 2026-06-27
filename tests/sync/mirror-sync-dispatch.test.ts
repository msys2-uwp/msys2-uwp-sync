import { describe, expect, test } from 'vitest';

function mirrorSyncReadyState(input: {
  WorkflowRegistered: boolean;
}): 'normal' | 'bootstrap' {
  return input.WorkflowRegistered ? 'normal' : 'bootstrap';
}

describe('mirrorSyncReadyState', () => {
  test('normal when workflow registered', () => {
    expect(mirrorSyncReadyState({ WorkflowRegistered: true })).toBe('normal');
  });

  test('bootstrap when workflow not registered', () => {
    expect(mirrorSyncReadyState({ WorkflowRegistered: false })).toBe('bootstrap');
  });
});
