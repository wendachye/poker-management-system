import test from "node:test";
import assert from "node:assert/strict";
import { getPokerSeatPositions } from "../src/components/page/PokerManagementPage/components/poker-table-geometry";

function near(actual: number, expected: number, tolerance = 1e-10) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

// Independent reference angles from integrating the analytic ellipse speed
// sqrt(width² cos²(t) + height² sin²(t)) with adaptive quadrature. These are
// 10% and 20% of the full perimeter, rather than equally spaced polar angles.
const rails = [
  {
    width: 137,
    height: 268,
    first: 44.87481640348916,
    second: 75.93739038220308,
  },
  {
    width: 208,
    height: 268,
    first: 39.543609200899304,
    second: 73.86754967770258,
  },
  {
    width: 252,
    height: 192,
    first: 32.561887390605996,
    second: 69.40078163773647,
  },
  {
    width: 492,
    height: 192,
    first: 27.084075276742187,
    second: 61.66526947524408,
  },
];

test("portrait and landscape rails place seats at equal perimeter intervals", () => {
  for (const { width, height, first, second } of rails) {
    const seats = getPokerSeatPositions(width, height);
    const expectedAngles = [
      first - 180,
      second - 180,
      -second,
      -first,
      0,
      first,
      second,
      180 - second,
      180 - first,
    ];

    assert.deepEqual(
      seats.map(({ seat }) => seat),
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
    for (const [index, seat] of seats.entries()) {
      near(seat.angle, expectedAngles[index], 0.0001);
      // Converting percentages back to normalized ellipse coordinates must
      // keep every seat center on the actual rail, at any aspect ratio.
      const x = (seat.xPercent - 50) / 50;
      const y = (seat.yPercent - 50) / 50;
      near(x * x + y * y, 1);
      assert.ok(seat.xPercent >= 0 && seat.xPercent <= 100);
      assert.ok(seat.yPercent >= 0 && seat.yPercent <= 100);
    }
  }
});

test("seat order is clockwise with one unused bottom station and exact symmetry", () => {
  for (const { width, height } of rails) {
    const seats = getPokerSeatPositions(width, height);
    const bySeat = new Map(seats.map((seat) => [seat.seat, seat]));
    const top = bySeat.get(5)!;
    near(top.xPercent, 50);
    near(top.yPercent, 0);
    near(top.angle, 0);

    for (let seat = 1; seat < 5; seat += 1) {
      const left = bySeat.get(seat)!;
      const right = bySeat.get(10 - seat)!;
      near(left.xPercent + right.xPercent, 100);
      near(left.yPercent, right.yPercent);
      near(left.angle, -right.angle);
    }
    // Reflection across the horizontal axis confirms the same spacing on
    // the lower rail while leaving the bottom-center station unoccupied.
    for (const [upper, lower] of [
      [6, 9],
      [7, 8],
    ]) {
      near(bySeat.get(upper)!.xPercent, bySeat.get(lower)!.xPercent);
      near(bySeat.get(upper)!.yPercent + bySeat.get(lower)!.yPercent, 100);
    }
    assert.ok(seats.every(({ yPercent }) => yPercent < 100));
    assert.ok(
      seats.every(
        ({ xPercent, yPercent }) => xPercent !== 50 || yPercent === 0,
      ),
    );

    const clockwiseAngles = [5, 6, 7, 8, 9, 1, 2, 3, 4].map((seat) => {
      const angle = bySeat.get(seat)!.angle;
      return angle < 0 ? angle + 360 : angle;
    });
    assert.ok(
      clockwiseAngles.every(
        (angle, index) => index === 0 || angle > clockwiseAngles[index - 1],
      ),
    );
  }
});

test("a circular rail has exact 36 degree stations and a double bottom gap", () => {
  const seats = getPokerSeatPositions(200, 200);
  const expected = [-144, -108, -72, -36, 0, 36, 72, 108, 144];
  seats.forEach((seat, index) => near(seat.angle, expected[index]));
  near(seats[0].angle + 360 - seats[8].angle, 72);
});

test("positions depend on aspect ratio rather than dimensions or numeric scale", () => {
  const baseline = getPokerSeatPositions(137, 268);
  for (const scale of [0.001, 2, 1e200]) {
    const scaled = getPokerSeatPositions(137 * scale, 268 * scale);
    scaled.forEach((seat, index) => {
      near(seat.xPercent, baseline[index].xPercent);
      near(seat.yPercent, baseline[index].yPercent);
      near(seat.angle, baseline[index].angle);
    });
  }
  for (const dimensions of [
    [Number.MAX_VALUE, 1],
    [1, Number.MAX_VALUE],
  ]) {
    const seats = getPokerSeatPositions(dimensions[0], dimensions[1]);
    assert.equal(seats.length, 9);
    assert.ok(
      seats.every((seat) => Object.values(seat).every(Number.isFinite)),
    );
  }
});

test("unmeasured and invalid rails have no seat positions", () => {
  for (const invalid of [0, -1, NaN, Infinity, -Infinity]) {
    assert.deepEqual(getPokerSeatPositions(invalid, 192), []);
    assert.deepEqual(getPokerSeatPositions(252, invalid), []);
  }
});
