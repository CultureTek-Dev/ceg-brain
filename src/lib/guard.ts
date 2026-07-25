import { config } from "../config.js";

/** Tiny concurrency limiter — protects a single subscription from bursts. */
let active = 0;
const queue: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < config.maxConcurrency) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release() {
  active--;
  const next = queue.shift();
  if (next) { active++; next(); }
}

export async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
