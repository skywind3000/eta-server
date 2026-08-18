// tslib.ts - TypeScript business library example
//
// Supported by Node 22.18+ built-in type stripping: templates can just
// require('./tslib.ts'), no tsc / ts-node / tsx needed. Note that only
// erasable syntax is supported: type annotations, interface, type and
// generics work; enum, namespace and parameter properties do not.

export interface User {
  name: string
  age: number
}

export function formatUser (u: User): string {
  return u.name + ' (age ' + String(u.age) + ')'
}

export function sum <T extends number> (list: T[]): number {
  let total: number = 0
  for (const n of list) total += n
  return total
}
