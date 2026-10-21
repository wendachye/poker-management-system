export type PokerSeatPosition = {
  seat: number;
  xPercent: number;
  yPercent: number;
  /** Degrees clockwise from the top; negative values are on the left. */
  angle: number;
};

const quarterSegments = 512;

/**
 * Nine seats occupy ten evenly spaced stations on the rail's perimeter.
 * The unused bottom station leaves the dealer position clear.
 * Pass the rail's dimensions, rather than the surrounding map's dimensions.
 */
export function getPokerSeatPositions(
  width: number,
  height: number,
): PokerSeatPosition[] {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return [];
  }

  // Normalization keeps length calculations finite even for very large rails.
  const scale = Math.max(width, height);
  const radiusX = width / scale;
  const radiusY = height / scale;
  const angleStep = Math.PI / (2 * quarterSegments);
  const lengths = [0];
  let previousX = 0;
  let previousY = -radiusY;

  // Sampling one quadrant is equivalent to 2,048 segments around the rail.
  // Reflecting it also avoids numerical drift between opposite seats.
  for (let index = 1; index <= quarterSegments; index += 1) {
    const angle = index * angleStep;
    const x = radiusX * Math.sin(angle);
    const y = -radiusY * Math.cos(angle);
    lengths.push(lengths[index - 1] + Math.hypot(x - previousX, y - previousY));
    previousX = x;
    previousY = y;
  }

  function angleAtQuarterFraction(fraction: number) {
    const target = lengths[quarterSegments] * fraction;
    let low = 0;
    let high = quarterSegments;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (lengths[middle] < target) low = middle;
      else high = middle;
    }
    const progress = (target - lengths[low]) / (lengths[high] - lengths[low]);
    return (low + progress) * angleStep;
  }

  // Each station is one tenth of the perimeter, or two fifths of a quadrant.
  const first = angleAtQuarterFraction(0.4);
  const second = angleAtQuarterFraction(0.8);
  const angles = [
    first - Math.PI,
    second - Math.PI,
    -second,
    -first,
    0,
    first,
    second,
    Math.PI - second,
    Math.PI - first,
  ];

  return angles.map((angle, index) => ({
    seat: index + 1,
    xPercent: 50 + 50 * Math.sin(angle),
    yPercent: 50 - 50 * Math.cos(angle),
    angle: (angle * 180) / Math.PI,
  }));
}
