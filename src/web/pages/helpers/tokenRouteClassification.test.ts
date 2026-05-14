import { describe, expect, it } from 'vitest';
import {
  isExactModelPattern,
  isExplicitGroupRoute,
  isModelGroupRoute,
  isRouteExactModel,
} from './tokenRouteClassification.js';

describe('tokenRouteClassification', () => {
  it('treats bracket-prefixed literal model names as exact patterns', () => {
    expect(isExactModelPattern('[NV]deepseek-v3.1-terminus')).toBe(true);
  });

  it('treats explicit groups as bindable model groups even with literal aliases', () => {
    const route = { modelPattern: 'opencai', routeMode: 'explicit_group' };

    expect(isExplicitGroupRoute(route)).toBe(true);
    expect(isRouteExactModel(route)).toBe(false);
    expect(isModelGroupRoute(route)).toBe(true);
  });

  it('classifies wildcard and regex routes as model groups', () => {
    expect(isModelGroupRoute({ modelPattern: 'claude-*' })).toBe(true);
    expect(isModelGroupRoute({ modelPattern: 're:^gemini-.*$' })).toBe(true);
    expect(isModelGroupRoute({ modelPattern: 'gpt-5.2' })).toBe(false);
  });
});
