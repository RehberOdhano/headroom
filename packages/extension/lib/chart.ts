import type { TimedPercent } from './history.js';

export interface SparklinePoint {
  x: number;
  y: number;
}

/** Maps a time series onto a 0–100 x 0–100 coordinate space for an SVG polyline: x by relative
 *  time position, y inverted (0 = top = 100%) so higher usage draws higher on the chart. */
export function toSparklinePoints(series: TimedPercent[]): SparklinePoint[] {
  if (series.length === 0) return [];
  const times = series.map((point) => new Date(point.capturedAt).getTime());
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const spanT = maxT - minT || 1;

  return series.map((point, i) => ({
    x: ((times[i]! - minT) / spanT) * 100,
    y: 100 - Math.min(100, Math.max(0, point.percent)),
  }));
}

/** `points` attribute value for an SVG `<polyline>`. */
export function sparklinePointsAttr(points: SparklinePoint[]): string {
  return points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
}
