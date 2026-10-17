declare module 'd3-force-3d' {
  export function forceSimulation<NodeDatum = any>(nodes?: NodeDatum[], numDimensions?: number): any
  export function forceManyBody<NodeDatum = any>(): any
  export function forceLink<NodeDatum = any, LinkDatum = any>(links?: LinkDatum[]): any
  export function forceCollide<NodeDatum = any>(radius?: number | ((node: NodeDatum) => number)): any
  export function forceCenter<NodeDatum = any>(x?: number, y?: number, z?: number): any
  export function forceRadial<NodeDatum = any>(radius?: number, x?: number, y?: number, z?: number): any
  export function forceX<NodeDatum = any>(x?: number): any
  export function forceY<NodeDatum = any>(y?: number): any
  export function forceZ<NodeDatum = any>(z?: number): any
}
