/**
 * Public surface of the indoor-wayfinding module.
 *
 * Callers should import from `@/lib/routing`, not from the individual
 * files inside — that lets us reorganize the internals (e.g. moving
 * A* into a WebWorker) without touching consumers.
 */

export { computeRoute } from './router'
export type { ComputeRouteOptions, RouteResultDebug } from './router'

export type {
  LngLat,
  RouteRequest,
  RouteResult,
  RouteStatus,
  RoutingBounds,
  RoutingDoor,
  RoutingObstacle,
  RoutingScene,
  RoutingWall,
} from './types'

export { buildRoutingScene, type BuildSceneInput } from './scene-adapter'

export {
  floorsOf,
  isStepFree,
  planRoutes,
  portalsOf,
  stepsOf,
  type FacilityRoutingInput,
  type Floor,
  type PlanResult,
  type Portal,
  type RouteOption,
  type Step,
} from './floors'
