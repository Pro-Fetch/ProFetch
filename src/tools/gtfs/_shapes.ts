/**
 * Shape geometry: measured length and a bounded simplification.
 *
 * `shapes.txt` is a polyline the feed draws under the vehicle: it exists so a map can show the route's
 * path, and it is the only place a GTFS file says anything about the road a vehicle actually takes. Two
 * things are worth computing rather than eyeballing:
 *
 * - **Length.** Summed great-circle distance between consecutive points, cross-checked against
 *   `shape_dist_traveled` when the feed bothers to fill it in. A feed whose two numbers disagree by a lot
 *   has either a duplicated point run or a mislabelled sequence, and the caller should see that rather
 *   than a single confident figure.
 * - **Simplification.** A national feed's shapes reach 950,000 points (measured on Entur's Norway file).
 *   Shipping all of them to a model or a map is useless, so points are reduced with Douglas–Peucker to a
 *   metre tolerance. The recursion is written as an explicit stack on purpose: a recursive version is the
 *   kind that dies on a long shape instead of finishing slowly.
 */
import { haversineMeters } from './_gtfs.js';

export interface ShapePoint {
  seq: number;
  lat: number;
  lon: number;
  dist: number | null;
}

/** Consecutive great-circle metres along a polyline. */
export function pathLengthMeters(points: ShapePoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineMeters(points[i - 1]!.lat, points[i - 1]!.lon, points[i]!.lat, points[i]!.lon);
  }
  return total;
}

/**
 * Distance from `point` to the line `a`–`b`, in metres, by the area of the triangle they form.
 *
 * Good enough for the purpose: it flattens over the few kilometres a tolerance ever spans, where the
 * error is far below the tolerance it is compared against. At a pole or on an antipodal pair the base can
 * collapse to zero, which is answered by returning the direct distance instead of dividing by it.
 */
export function perpendicularMeters(point: ShapePoint, a: ShapePoint, b: ShapePoint): number {
  const base = haversineMeters(a.lat, a.lon, b.lat, b.lon);
  if (base < 0.5) return haversineMeters(a.lat, a.lon, point.lat, point.lon);
  const sideA = haversineMeters(a.lat, a.lon, point.lat, point.lon);
  const sideB = haversineMeters(b.lat, b.lon, point.lat, point.lon);
  // Heron's formula for the area, then height = 2 * area / base.
  const s = (base + sideA + sideB) / 2;
  const squared = s * (s - base) * (s - sideA) * (s - sideB);
  const area = squared > 0 ? Math.sqrt(squared) : 0;
  return (2 * area) / base;
}

/**
 * Douglas–Peucker, iteratively, keeping the first and last point always.
 *
 * The result is a subset of the input in the original order, so it is still a legal polyline: nothing is
 * interpolated, nothing is smoothed into a curve the feed never drew.
 */
export function simplifyShape(points: ShapePoint[], toleranceMeters: number): ShapePoint[] {
  if (points.length < 3 || toleranceMeters <= 0) return points.slice();
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  let checked = 0;
  while (stack.length) {
    const [start, end] = stack.pop()!;
    if (end <= start + 1) continue;
    let worst = -1;
    let worstIndex = -1;
    for (let i = start + 1; i < end; i++) {
      const distance = perpendicularMeters(points[i]!, points[start]!, points[end]!);
      if (distance > worst) {
        worst = distance;
        worstIndex = i;
      }
      checked++;
    }
    if (worst > toleranceMeters && worstIndex > start) {
      keep[worstIndex] = true;
      stack.push([start, worstIndex], [worstIndex, end]);
    }
  }
  const out = points.filter((_, index) => keep[index]);
  return out.length >= 2 ? out : points.slice(0, 2);
}

/** Bounding box of a polyline, for a map that has to set its viewport before drawing anything. */
export function shapeBounds(
  points: ShapePoint[],
): { min_lat: number; max_lat: number; min_lon: number; max_lon: number } | null {
  if (!points.length) return null;
  let minLat = points[0]!.lat;
  let maxLat = points[0]!.lat;
  let minLon = points[0]!.lon;
  let maxLon = points[0]!.lon;
  for (const point of points) {
    if (point.lat < minLat) minLat = point.lat;
    if (point.lat > maxLat) maxLat = point.lat;
    if (point.lon < minLon) minLon = point.lon;
    if (point.lon > maxLon) maxLon = point.lon;
  }
  return { min_lat: minLat, max_lat: maxLat, min_lon: minLon, max_lon: maxLon };
}

/**
 * The feed's own `shape_dist_traveled`, if it was filled in, and how far it disagrees with the geometry.
 *
 * Reported as a measurement, not a verdict: a feed may leave the column empty, may start it at a value
 * other than zero, or measure along the road while the polyline cuts corners. The difference is what a
 * caller needs in order to decide which number to trust.
 */
export function distCheck(
  points: ShapePoint[],
  lengthMeters: number,
): { declared: boolean; declared_m: number | null; delta_m: number | null } {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || first.dist === null || last.dist === null)
    return { declared: false, declared_m: null, delta_m: null };
  const declaredM = last.dist - first.dist;
  return { declared: true, declared_m: declaredM, delta_m: Math.round(declaredM - lengthMeters) };
}
