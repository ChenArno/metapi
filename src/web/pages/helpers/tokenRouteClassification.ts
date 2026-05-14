import { normalizeTokenRouteMode, type RouteMode } from '../../../shared/tokenRouteContract.js';
import { isExactTokenRouteModelPattern } from '../../../shared/tokenRoutePatterns.js';

export type TokenRouteClassifiable = {
  modelPattern: string;
  routeMode?: RouteMode | string | null;
};

export function normalizeRouteMode(routeMode: RouteMode | string | null | undefined): RouteMode {
  return normalizeTokenRouteMode(routeMode);
}

export function isExactModelPattern(modelPattern: string): boolean {
  return isExactTokenRouteModelPattern(modelPattern);
}

export function isExplicitGroupRoute(route: Pick<TokenRouteClassifiable, 'routeMode'>): boolean {
  return normalizeRouteMode(route.routeMode) === 'explicit_group';
}

export function isRouteExactModel(route: TokenRouteClassifiable): boolean {
  return !isExplicitGroupRoute(route) && isExactModelPattern(route.modelPattern);
}

export function isModelGroupRoute(route: TokenRouteClassifiable): boolean {
  return isExplicitGroupRoute(route) || !isExactModelPattern(route.modelPattern);
}
