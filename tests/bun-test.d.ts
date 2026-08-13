declare module "bun:test" {
  interface Matchers {
    toBe(expected: unknown): void;
    toBeLessThan(expected: number): void;
    toBeUndefined(): void;
    toBeString(): void;
    toContain(expected: unknown): void;
    toEqual(expected: unknown): void;
    toMatch(expected: RegExp): void;
    not: Matchers;
  }

  export function describe(name: string, callback: () => void): void;
  export function expect<T>(value: T): Matchers;
  export function test(
    name: string,
    callback: () => void | Promise<void>,
  ): void;
}
