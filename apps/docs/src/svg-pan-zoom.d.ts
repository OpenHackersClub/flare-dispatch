// Minimal ambient types for svg-pan-zoom — the package ships no types and we
// only use a small slice of its API (see components/MermaidRunner.astro).
declare module "svg-pan-zoom" {
  export interface SvgPanZoomInstance {
    zoomIn(): void;
    zoomOut(): void;
    zoom(scale: number): void;
    reset(): void;
    resize(): void;
    fit(): void;
    center(): void;
    updateBBox(): void;
    destroy(): void;
  }

  export interface SvgPanZoomOptions {
    zoomEnabled?: boolean;
    panEnabled?: boolean;
    controlIconsEnabled?: boolean;
    dblClickZoomEnabled?: boolean;
    mouseWheelZoomEnabled?: boolean;
    preventMouseEventsDefault?: boolean;
    fit?: boolean;
    contain?: boolean;
    center?: boolean;
    minZoom?: number;
    maxZoom?: number;
    zoomScaleSensitivity?: number;
  }

  const svgPanZoom: (
    element: SVGElement | string,
    options?: SvgPanZoomOptions,
  ) => SvgPanZoomInstance;

  export default svgPanZoom;
}
