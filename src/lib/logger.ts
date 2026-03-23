const prefix = '[NeetHub]';

export function log(...args: unknown[]): void {
  console.log(prefix, ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(prefix, ...args);
}

export function error(...args: unknown[]): void {
  console.error(prefix, ...args);
}
