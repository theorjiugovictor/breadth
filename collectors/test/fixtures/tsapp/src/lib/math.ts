/** Add two numbers. */
export function add(a: number, b: number = 0): number {
  return a + b;
}

export const double = (x: number): number => add(x, x);

let counter = 0;
export function tick(): number {
  counter++;
  return counter;
}
